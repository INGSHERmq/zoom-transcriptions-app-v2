// src/components/MeetingDetail.jsx
import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { zoomApi } from '../services/zoomApi'
import { formatDate } from '../utils/formatDate'

export default function MeetingDetail() {
  const { uuid } = useParams()
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    zoomApi.getTranscript(uuid)
      .then(setInfo)
      .finally(() => setLoading(false))
  }, [uuid])

  if (loading) return <div className="p-20 text-center text-2xl">Cargando detalle...</div>

  const c = info.meeting

  const tardanza = c.delay_minutes
  const esTardanza = tardanza !== null && tardanza > 0
  const esTemprano = tardanza !== null && tardanza < 0

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="max-w-5xl mx-auto">
        <Link to="/" className="inline-block mb-8 text-indigo-600 hover:underline text-lg font-medium">
          ← Volver al dashboard
        </Link>

        <div className="bg-white rounded-3xl shadow-2xl overflow-hidden">
          {/* Header con título y estado */}
          <div className="bg-gradient-to-r from-indigo-600 to-purple-700 text-white p-8">
            <h1 className="text-4xl font-bold mb-4">{c.topic}</h1>
            <p className="text-xl opacity-90">Host: {c.host_email || '—'}</p>
          </div>

          <div className="p-10 space-y-8">
            {/* Resumen de horarios */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="bg-gray-50 rounded-2xl p-6 border-l-8 border-indigo-600">
                <h3 className="text-2xl font-bold text-gray-800 mb-4">Horario Programado</h3>
                <p className="text-lg"><strong>Inicio:</strong> {formatDate(c.scheduled_start)}</p>
                <p className="text-lg"><strong>Fin teórico:</strong> {c.theoretical_end ? formatDate(c.theoretical_end) : '—'}</p>
              </div>

              <div className="bg-gray-50 rounded-2xl p-6 border-l-8 border-green-600">
                <h3 className="text-2xl font-bold text-gray-800 mb-4">Horario Real</h3>
                <p className="text-lg"><strong>Inicio real:</strong> {formatDate(c.actual_start)}</p>
                <p className={`
                  text-2xl font-bold mt-3
                  ${esTardanza ? 'text-red-600' : 
                    esTemprano ? 'text-green-600' : 
                    'text-gray-700'}
                `}>
                  {esTardanza && `⚠️ +${tardanza} min tarde`}
                  {esTemprano && `✅ ${Math.abs(tardanza)} min antes`}
                  {tardanza === 0 && `✅ A tiempo`}
                  {tardanza === null && `—`}
                </p>
                <p className="text-lg mt-4"><strong>Fin real:</strong> {c.actual_end ? formatDate(c.actual_end) : 'En curso'}</p>
                <p className="text-lg"><strong>Duración real:</strong> {c.duration_minutes || '—'} min</p>
              </div>
            </div>

            {/* Transcripción */}
            <div className="bg-gray-50 rounded-2xl p-8">
              <h2 className="text-3xl font-bold text-gray-800 mb-6">Transcripción completa</h2>
              {info.transcript ? (
                <pre className="whitespace-pre-wrap font-sans text-lg leading-relaxed text-gray-800 bg-white p-6 rounded-xl shadow">
                  {info.transcript}
                </pre>
              ) : (
                <p className="text-xl text-gray-500">Transcripción no disponible aún</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}