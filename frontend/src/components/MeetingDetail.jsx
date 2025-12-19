// frontend\src\components\MeetingDetail.jsx
import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { claseApi } from '../services/claseApi';
import { formatDate } from '../utils/formatDate';

export default function MeetingDetail() {
  const { uuid } = useParams();
  const [clase, setClase] = useState(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState(null);
  const [error, setError] = useState(null);

  const pollingIntervalRef = useRef(null);
  const mountedRef = useRef(true);
  const previousContentRef = useRef({ transcription: null, video_url: null });

  const formatDateSafe = (date) => (!date ? '—' : formatDate(date));

  const checkForUpdates = useCallback(async () => {
    if (!mountedRef.current) return;

    try {
      const result = await claseApi.getTranscript(uuid);
      const { meeting, transcript, video_url } = result;

      if (!mountedRef.current) return;

      const prev = previousContentRef.current;
      const hasNewTranscript = transcript && transcript !== prev.transcription;
      const hasNewVideo = video_url && video_url !== prev.video_url;

      if (hasNewTranscript || hasNewVideo) {
        setClase(meeting);
        previousContentRef.current = { transcription: transcript, video_url: video_url };

        setNotification({
          topic: meeting?.topic || 'Clase',
          hasVideo: hasNewVideo,
          hasTranscript: hasNewTranscript
        });

        setTimeout(() => {
          if (mountedRef.current) setNotification(null);
        }, 6000);
      }

      // Detener polling si ya tiene transcripción o video
      if (transcript || video_url) {
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      }
    } catch (err) {
      console.warn('⚠️ Error en polling:', err.message);
    }
  }, [uuid]); // Solo depende de uuid → estable

  useEffect(() => {
    mountedRef.current = true;

    const loadData = async () => {
      try {
        setLoading(true);
        setError(null);

        const data = await claseApi.getTranscript(uuid);
        const { meeting, transcript, video_url } = data;

        if (!mountedRef.current) return;

        setClase(meeting);
        previousContentRef.current = { transcription: transcript, video_url: video_url };

        if (transcript || video_url) {
          setNotification({
            topic: meeting?.topic || 'Clase',
            hasVideo: !!video_url,
            hasTranscript: !!transcript
          });
          setTimeout(() => setNotification(null), 6000);
        } else {
          pollingIntervalRef.current = setInterval(checkForUpdates, 30000);
          checkForUpdates();
        }
      } catch (err) {
        if (mountedRef.current) setError(err.message || 'Error al cargar la clase');
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    };

    loadData();

    return () => {
      mountedRef.current = false;
      if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
    };
  }, [uuid, checkForUpdates]);

  if (error) {
    return (
      <div className="p-20 text-center">
        <p className="text-2xl text-red-600 font-bold mb-4">❌ Error: {error}</p>
        <Link to="/" className="text-indigo-600 hover:underline mt-4 inline-block">← Volver al dashboard</Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-20 text-center">
        <div className="w-16 h-16 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
        <p className="text-2xl text-gray-600">Cargando detalle...</p>
      </div>
    );
  }

  if (!clase) {
    return (
      <div className="p-20 text-center">
        <p className="text-2xl text-red-600 font-bold mb-4">🤷 Clase no encontrada</p>
        <Link to="/" className="text-indigo-600 hover:underline mt-4 inline-block">← Volver al dashboard</Link>
      </div>
    );
  }

  const c = clase;
  const enCurso = !c.actual_end && c.status === 'live';

  let finTeorico = '—';
  if (c.scheduled_start && c.duration_minutes) {
    const start = new Date(c.scheduled_start);
    if (!isNaN(start.getTime())) {
      finTeorico = formatDate(new Date(start.getTime() + c.duration_minutes * 60000));
    }
  }

  let duracionReal = c.duration_minutes ? `${c.duration_minutes} min` : '—';
  if (c.actual_start && c.actual_end) {
    const diff = Math.round((new Date(c.actual_end) - new Date(c.actual_start)) / 60000);
    duracionReal = `${diff} min`;
  }

  const punctuality = c.punctuality || { start: {}, end: {} };
  const getStatusColor = (s) => s === 'late' || s === 'early' ? 'text-red-600' : s === 'on_time' ? 'text-green-600' : 'text-gray-700';
  const getIcon = (s) => s === 'late' || s === 'early' ? '⚠️' : s === 'on_time' ? '✅' : '';

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      {/* Notificación */}
      {notification && (
        <div className="fixed top-4 right-4 z-50 animate-slide-in">
          <div className="bg-green-600 text-white rounded-lg shadow-2xl p-6 max-w-md flex items-start gap-4">
            <div className="text-3xl">✔</div>
            <div>
              <h3 className="font-bold text-lg">¡Contenido disponible!</h3>
              <p className="text-sm opacity-95">{notification.topic}</p>
              <p className="text-sm mt-2">
                {notification.hasVideo && "🎥 Video listo"}
                {notification.hasVideo && notification.hasTranscript && " • "}
                {notification.hasTranscript && "📄 Transcripción lista"}
              </p>
            </div>
            <button onClick={() => setNotification(null)} className="text-white hover:bg-green-700 rounded p-1">✕</button>
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto">
        <Link to="/" className="inline-block mb-8 text-indigo-600 hover:underline text-lg font-medium">
          ← Volver al dashboard
        </Link>

        <div className="bg-white rounded-3xl shadow-2xl overflow-hidden">
          <div className="bg-gradient-to-r from-indigo-600 to-purple-700 text-white p-8">
            <h1 className="text-4xl font-bold mb-4">{c.topic || 'Sin título'}</h1>
            <p className="text-xl opacity-90">Host: {c.host_email || '—'}</p>
            <p className="text-lg opacity-75 mt-2">
              Estado: <span className="font-bold">{c.status}</span>
              {enCurso && <span className="ml-2 text-green-300">● EN CURSO</span>}
            </p>
          </div>

          <div className="p-10 space-y-8">
            {/* Horarios */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="bg-gray-50 rounded-2xl p-6 border-l-8 border-indigo-600">
                <h3 className="text-2xl font-bold text-gray-800 mb-4">Horario Programado</h3>
                <p className="text-lg mb-3"><strong>Inicio:</strong> {formatDateSafe(c.scheduled_start)}</p>
                <p className="text-lg"><strong>Fin teórico:</strong> {finTeorico}</p>
              </div>

              <div className="bg-gray-50 rounded-2xl p-6 border-l-8 border-green-600">
                <h3 className="text-2xl font-bold text-gray-800 mb-4">Horario Real</h3>
                <p className="text-lg mb-3"><strong>Inicio real:</strong> {formatDateSafe(c.actual_start)}</p>
                {punctuality.start.message !== '—' && (
                  <p className={`text-xl font-bold mb-4 ${getStatusColor(punctuality.start.status)}`}>
                    {getIcon(punctuality.start.status)} {punctuality.start.message}
                  </p>
                )}
                <p className="text-lg mb-3"><strong>Fin real:</strong> {enCurso ? 'En curso' : formatDateSafe(c.actual_end)}</p>
                {!enCurso && punctuality.end.message !== '—' && (
                  <p className={`text-xl font-bold mb-4 ${getStatusColor(punctuality.end.status)}`}>
                    {getIcon(punctuality.end.status)} {punctuality.end.message}
                  </p>
                )}
                <p className="text-lg"><strong>Duración real:</strong> {duracionReal}</p>
              </div>
            </div>

            {/* Grabación y Resumen */}
            <div className="bg-gray-50 rounded-2xl p-8">
              <h2 className="text-3xl font-bold text-gray-800 mb-8">Grabación y Resumen de la Clase</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                {/* Botón Video */}
                <button
                  onClick={() => c.video_url && window.open(c.video_url, '_blank', 'noopener,noreferrer')}
                  className={`py-12 px-8 rounded-2xl shadow-xl font-bold text-2xl transition-all transform hover:scale-105 flex flex-col items-center justify-center ${
                    c.video_url
                      ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                      : 'bg-orange-500 text-white hover:bg-orange-600'
                  }`}
                >
                  <span className="text-6xl mb-4">🎥</span>
                  Video (Grabación de Zoom)
                  {c.video_url ? (
                    <p className="text-base font-normal mt-3">Reproducir ahora</p>
                  ) : (
                    <p className="text-base font-normal mt-3 text-center">
                      Estamos procesando el video...<br />Gracias por la espera
                    </p>
                  )}
                </button>

                {/* Botón Resumen */}
                <button
                  onClick={() => setShowTranscript(true)}
                  disabled={!c.transcription}
                  className={`py-12 px-8 rounded-2xl shadow-xl font-bold text-2xl transition-all transform hover:scale-105 flex flex-col items-center justify-center ${
                    c.transcription
                      ? 'bg-purple-600 text-white hover:bg-purple-700'
                      : 'bg-gray-300 text-gray-600 cursor-not-allowed'
                  }`}
                >
                  <span className="text-6xl mb-4">📄</span>
                  Resumen (Transcripción)
                  {!c.transcription && (
                    <p className="text-base font-normal mt-3">
                      {enCurso ? 'Procesando...' : 'No disponible'}
                    </p>
                  )}
                </button>
              </div>

              {/* Transcripción */}
              {showTranscript && c.transcription && (
                <div className="mt-8 animate-fade-in">
                  <pre className="whitespace-pre-wrap font-sans text-lg leading-relaxed text-gray-800 bg-white p-8 rounded-xl shadow-lg">
                    {c.transcription}
                  </pre>
                </div>
              )}

              {/* Sin contenido */}
              {!c.transcription && !c.video_url && !enCurso && (
                <div className="text-center py-12 text-gray-500">
                  <p className="text-xl">🔍 No se encontró grabación ni transcripción.</p>
                  <p className="text-sm mt-4">Puede que la grabación en la nube no esté activada o aún esté procesándose.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}