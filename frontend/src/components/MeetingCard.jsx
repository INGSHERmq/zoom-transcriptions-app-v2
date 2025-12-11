// src/components/MeetingCard.jsx
import { Link } from 'react-router-dom'
import { formatDate } from '../utils/formatDate'

export default function MeetingCard({ meeting, type = 'past' }) {
  const isLive = type === 'live'

  return (
    <div className="relative rounded-2xl overflow-hidden shadow-lg hover:shadow-2xl transition-all duration-300">
      {/* Barra superior de color */}
      <div className={`
        h-2 
        ${isLive ? 'bg-green-500' : 
          type === 'ended' ? 'bg-gray-600' : 
          type === 'scheduled' ? 'bg-blue-600' : 
          'bg-orange-600'}
      `} />

      <div className="p-6 bg-white">
        {/* Título con hasta 3 líneas */}
        <h3 className="text-xl font-bold text-gray-800 mb-4 line-clamp-3 leading-tight">
          {meeting.topic}
        </h3>

        <div className="space-y-2 text-sm text-gray-600">
          <p className="truncate">
            <strong>Host:</strong> {meeting.host_email || '—'}
          </p>

          {isLive && (
            <p className="text-green-600 font-bold text-base">
              EN VIVO {formatDate(meeting.actual_start || meeting.start_time)}
            </p>
          )}

          {meeting.actual_start && !isLive && (
            <p>
              <strong>Inicio:</strong> {formatDate(meeting.actual_start)}
            </p>
          )}

          {meeting.actual_end && (
            <>
              <p><strong>Fin:</strong> {formatDate(meeting.actual_end)}</p>
              <p><strong>Duración:</strong> {meeting.duration_minutes || '—'} min</p>
            </>
          )}

          {meeting.scheduled_start && !meeting.actual_start && (
            <p className="text-blue-600 font-medium">
              <strong>Programada:</strong> {formatDate(meeting.scheduled_start)}
            </p>
          )}
        </div>

        {/* Botón solo en finalizadas */}
        {type === 'ended' && (
          <div className="mt-6">
            <Link
              to={`/meeting/${encodeURIComponent(meeting.zoom_uuid || meeting.uuid)}`}
              className="block text-center bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-lg transition text-sm"
            >
              Ver transcripción →
            </Link>
          </div>
        )}

        {/* Punto parpadeante en vivo */}
        {isLive && (
          <div className="absolute top-4 right-4">
            <span className="flex h-4 w-4">
              <span className="animate-ping absolute inline-flex h-4 w-4 rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-4 w-4 bg-green-500"></span>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}