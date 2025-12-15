//frontend\src\components\MeetingDetail.jsx
import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { claseApi } from '../services/claseApi';
import { formatDate } from '../utils/formatDate';

export default function MeetingDetail() {
  const { uuid } = useParams();
  const [clase, setClase] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState(null);
  const [error, setError] = useState(null);
  
  // Control de polling
  const pollingIntervalRef = useRef(null);
  const mountedRef = useRef(true);

  const formatDateSafe = (date) => {
    if (!date) return '—';
    return formatDate(date); 
  };

  // 🔄 Función para verificar transcripción
  const checkTranscription = useCallback(async () => {
    if (!mountedRef.current) return;

    try {
      const result = await claseApi.getTranscript(uuid);
      const newTranscript = result?.transcript;

      if (newTranscript && mountedRef.current) {
        // Actualizar el estado de la clase con la transcripción
        setClase(prev => ({
          ...prev,
          transcription: newTranscript
        }));

        // Mostrar notificación
        setNotification({
          topic: clase?.topic || 'Clase',
          id: clase?.id,
          occurrence: clase?.occurrence_id
        });
        setTimeout(() => {
          if (mountedRef.current) setNotification(null);
        }, 5000);

        // Detener polling
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      }
    } catch (err) {
      console.warn('⚠️ Error al verificar transcripción:', err.message);
    }
  }, [uuid, clase?.topic, clase?.id, clase?.occurrence_id]);

  // 📥 Cargar datos iniciales
  useEffect(() => {
    mountedRef.current = true;
    
    const loadData = async () => {
      try {
        setLoading(true);
        setError(null);

        const data = await claseApi.getClaseDetalle(uuid);
        
        if (!mountedRef.current) return;
        
        setClase(data);
        console.log('✅ Clase cargada:', data);

        // Si ya tiene transcripción, mostrar notificación y no hacer polling
        if (data.transcription) {
          setNotification({
            topic: data.topic || 'Clase',
            id: data.id,
            occurrence: data.occurrence_id
          });
          setTimeout(() => {
            if (mountedRef.current) setNotification(null);
          }, 5000);
        } else {
          // Si NO tiene transcripción, iniciar polling
          console.log('🔄 Iniciando polling para transcripción...');
          pollingIntervalRef.current = setInterval(checkTranscription, 30000);
          
          // Verificar inmediatamente
          checkTranscription();
        }
      } catch (err) {
        console.error('❌ Error al cargar clase:', err);
        if (mountedRef.current) {
          setError(err.message || 'Error al cargar la clase');
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    };

    loadData();

    // Cleanup
    return () => {
      mountedRef.current = false;
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [uuid, checkTranscription]);

  const closeNotification = () => {
    setNotification(null);
  };

  // === RENDER STATES ===
  if (error) {
    return (
      <div className="p-20 text-center">
        <p className="text-2xl text-red-600 font-bold mb-4">❌ Error: {error}</p>
        <Link to="/" className="text-indigo-600 hover:underline mt-4 inline-block">
          ← Volver al dashboard
        </Link>
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
        <p className="text-2xl text-red-600 font-bold mb-4">🤷 No se encontraron datos</p>
        <Link to="/" className="text-indigo-600 hover:underline mt-4 inline-block">
          ← Volver al dashboard
        </Link>
      </div>
    );
  }

  // === CÁLCULOS SIMPLES (solo presentación) ===
  const c = clase;

  // Fin teórico (para mostrar)
  let finTeorico = '—';
  try {
    if (c.scheduled_start && c.duration_minutes) {
      const start = new Date(c.scheduled_start);
      if (!isNaN(start.getTime())) {
        finTeorico = formatDate(new Date(start.getTime() + c.duration_minutes * 60000));
      }
    }
  } catch (e) {
    console.error('Error fin teórico:', e);
  }

  // Duración real (para mostrar)
  let duracionReal = '—';
  try {
    if (c.actual_start && c.actual_end) {
      const start = new Date(c.actual_start);
      const end = new Date(c.actual_end);
      if (!isNaN(start) && !isNaN(end)) {
        duracionReal = `${Math.round((end - start) / 60000)} min`;
      }
    } else if (c.duration_minutes) {
      duracionReal = `${c.duration_minutes} min`;
    }
  } catch (e) {
    console.error('Error duración real:', e);
  }

  // ✅ PUNTUALIDAD VIENE DEL BACKEND
  const punctuality = c.punctuality || { start: {}, end: {} };
  
  // Helpers para CSS
  const getStatusColor = (status) => {
    if (status === 'late' || status === 'early') return 'text-red-600';
    if (status === 'on_time') return 'text-green-600';
    return 'text-gray-700';
  };

  const getStatusIcon = (status) => {
    if (status === 'late' || status === 'early') return '⚠️';
    if (status === 'on_time') return '✅';
    return '';
  };

  // Para el caso especial del inicio (early es bueno)
  const getStartStatusColor = (status) => {
    if (status === 'late') return 'text-red-600';
    if (status === 'early' || status === 'on_time') return 'text-green-600';
    return 'text-gray-700';
  };

  const getStartStatusIcon = (status) => {
    if (status === 'late') return '⚠️';
    if (status === 'early' || status === 'on_time') return '✅';
    return '';
  };

  const enCurso = !c.actual_end && c.status === 'live';

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      {/* Notificación */}
      {notification && (
        <div className="fixed top-4 right-4 z-50 animate-slide-in">
          <div className="bg-green-600 text-white rounded-lg shadow-2xl p-6 max-w-md flex items-start gap-4">
            <div className="w-6 h-6 flex-shrink-0 mt-1">
              <svg className="w-full h-full" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-lg mb-1">🎉 ¡Transcripción Disponible!</h3>
              <p className="text-sm opacity-95">
                Transcripción lista para: <strong>{notification.topic}</strong>
              </p>
              <p className="text-xs opacity-80 mt-2">
                ID: {notification.id}
                {notification.occurrence && ` • Ocurrencia: ${notification.occurrence}`}
              </p>
            </div>
            <button onClick={closeNotification} className="text-white hover:bg-green-700 rounded p-1">✕</button>
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
              Estado: <span className="font-bold">{c.status || '—'}</span>
              {enCurso && <span className="ml-2 text-green-300">● EN CURSO</span>}
            </p>
          </div>

          <div className="p-10 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="bg-gray-50 rounded-2xl p-6 border-l-8 border-indigo-600">
                <h3 className="text-2xl font-bold text-gray-800 mb-4">Horario Programado</h3>
                <p className="text-lg mb-3"><strong>Inicio:</strong> {formatDateSafe(c.scheduled_start)}</p>
                <p className="text-lg"><strong>Fin teórico:</strong> {finTeorico}</p>
              </div>

              <div className="bg-gray-50 rounded-2xl p-6 border-l-8 border-green-600">
                <h3 className="text-2xl font-bold text-gray-800 mb-4">Horario Real</h3>
                <p className="text-lg mb-3"><strong>Inicio real:</strong> {formatDateSafe(c.actual_start)}</p>
                
                {/* ✅ Indicador de puntualidad de INICIO (del backend) */}
                {punctuality.start.message !== '—' && (
                  <p className={`text-xl font-bold mb-4 ${getStartStatusColor(punctuality.start.status)}`}>
                    {getStartStatusIcon(punctuality.start.status)} {punctuality.start.message}
                  </p>
                )}
                
                <p className="text-lg mb-3"><strong>Fin real:</strong> {enCurso ? 'En curso' : formatDateSafe(c.actual_end)}</p>
                
                {/* ✅ Indicador de puntualidad de FIN (del backend) */}
                {!enCurso && punctuality.end.message !== '—' && (
                  <p className={`text-xl font-bold mb-4 ${getStatusColor(punctuality.end.status)}`}>
                    {getStatusIcon(punctuality.end.status)} {punctuality.end.message}
                  </p>
                )}
                
                <p className="text-lg"><strong>Duración real:</strong> {duracionReal}</p>
              </div>
            </div>

            <div className="bg-gray-50 rounded-2xl p-8">
              <h2 className="text-3xl font-bold text-gray-800 mb-6">Transcripción completa</h2>
              {c.transcription ? (
                <pre className="whitespace-pre-wrap font-sans text-lg leading-relaxed text-gray-800 bg-white p-6 rounded-xl shadow">
                  {c.transcription}
                </pre>
              ) : (
                <div className="text-center py-8">
                  <div className="w-16 h-16 border-4 border-gray-300 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4"></div>
                  <p className="text-xl text-gray-500 font-medium">
                    {enCurso ? '⏳ Clase en curso - transcripción disponible al finalizar' : '📄 Transcripción no disponible aún'}
                  </p>
                  {!enCurso && <p className="text-sm text-gray-400 mt-2">🔄 Verificando cada 30 segundos...</p>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`@keyframes slide-in { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } } .animate-slide-in { animation: slide-in 0.3s ease-out; }`}</style>
    </div>
  );
}