// src/components/Dashboard.jsx
import { useEffect, useState, useRef } from 'react'
import { zoomApi } from '../services/zoomApi'
import MeetingCard from './MeetingCard'

export default function Dashboard() {
  const [data, setData] = useState({ live: [], past: [], scheduled: [], noAperturadas: [] })
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('proximas')
  const [lastUpdate, setLastUpdate] = useState(null)
  
  // Ref para evitar que el loading afecte las actualizaciones automáticas
  const isInitialLoad = useRef(true)

  useEffect(() => {
    const load = async (showLoading = false) => {
      try {
        // Solo mostrar loading en la carga inicial
        if (showLoading && isInitialLoad.current) {
          setLoading(true)
        }

        const res = await zoomApi.getMeetings()
        
        // Actualizar datos sin afectar la UI
        setData({
          live: res.live || [],
          past: res.past || [],
          scheduled: res.scheduled || [],
          noAperturadas: res.noAperturadas || []
        })
        
        setLastUpdate(new Date())
        
        if (isInitialLoad.current) {
          isInitialLoad.current = false
          setLoading(false)
        }
      } catch (err) {
        console.error("Error cargando datos:", err)
        if (isInitialLoad.current) {
          setLoading(false)
          isInitialLoad.current = false
        }
      }
    }

    // Carga inicial con loading
    load(true)
    
    // Actualizaciones automáticas sin loading
    const interval = setInterval(() => load(false), 10000)
    
    return () => clearInterval(interval)
  }, [])

  // MAPEO CORRECTO: activeTab → key en data
  const tabToDataKey = {
    'live': 'live',
    'finalizadas': 'past',
    'proximas': 'scheduled',
    'noAperturadas': 'noAperturadas'
  }

  const tabs = [
    { id: 'live',         label: 'En curso',       count: data.live.length,         color: 'bg-green-500' },
    { id: 'finalizadas',  label: 'Finalizadas',    count: data.past.length,         color: 'bg-gray-700' },
    { id: 'proximas',     label: 'Próximas',       count: data.scheduled.length,    color: 'bg-blue-600' },
    { id: 'noAperturadas',label: 'No aperturadas', count: data.noAperturadas.length,color: 'bg-orange-600' },
  ]

  // Obtener la lista correcta usando el mapeo
  const dataKey = tabToDataKey[activeTab]
  const currentList = data[dataKey] || []

  // Formatear hora de última actualización
  const formatLastUpdate = () => {
    if (!lastUpdate) return ''
    const now = new Date()
    const diff = Math.floor((now - lastUpdate) / 1000)
    if (diff < 5) return 'Actualizado ahora'
    if (diff < 60) return `Actualizado hace ${diff}s`
    return `Actualizado hace ${Math.floor(diff / 60)}m`
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="inline-block h-16 w-16 animate-spin rounded-full border-4 border-solid border-indigo-600 border-r-transparent mb-4"></div>
          <p className="text-2xl text-gray-700 font-medium">Cargando clases...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-100 flex">
      <aside className="w-80 bg-gray-900 text-white flex flex-col">
        <div className="p-8 border-b border-gray-800">
          <h1 className="text-3xl font-bold">Mis Clases</h1>
          {lastUpdate && (
            <p className="text-sm text-gray-400 mt-2">{formatLastUpdate()}</p>
          )}
        </div>
        <nav className="flex-1 px-6 py-6 space-y-2">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full text-left px-6 py-4 rounded-xl flex items-center justify-between transition-all ${
                activeTab === tab.id ? 'bg-gray-800 ring-2 ring-indigo-500' : 'hover:bg-gray-800'
              }`}
            >
              <span className="text-lg font-medium">{tab.label}</span>
              <span className={`px-4 py-1 rounded-full text-sm font-bold text-white ${tab.color} transition-all`}>
                {tab.count}
              </span>
            </button>
          ))}
        </nav>
        <div className="p-6 border-t border-gray-800">
          <button 
            onClick={() => { localStorage.removeItem('zoom_logged'); window.location.reload() }}
            className="w-full bg-red-600 hover:bg-red-700 py-3 rounded-xl font-bold transition-colors"
          >
            Cerrar sesión
          </button>
        </div>
      </aside>

      <main className="flex-1 p-10">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-4xl font-bold text-gray-800">
            {tabs.find(t => t.id === activeTab)?.label} ({currentList.length})
          </h2>
          
          {/* Indicador de actualización en tiempo real */}
          <div className="flex items-center gap-2 text-gray-600">
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></div>
            <span className="text-sm">Actualizando en tiempo real</span>
          </div>
        </div>

        {currentList.length === 0 ? (
          <div className="text-center py-20">
            <svg className="mx-auto h-24 w-24 text-gray-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-2xl text-gray-500 font-medium">No hay clases aquí</p>
            <p className="text-gray-400 mt-2">Las clases aparecerán automáticamente</p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {currentList.map(cls => (
              <MeetingCard
                key={cls.id || cls.zoom_uuid}
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