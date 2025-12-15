// src/services/claseApi.js
import axios from 'axios'

const API_BASE = 'https://46dbeac0d3e8.ngrok-free.app'

const instance = axios.create({
  baseURL: API_BASE,
  headers: { 'ngrok-skip-browser-warning': 'true' }
})

export const claseApi = {
  getClaseDetalle: (uuid, occurrenceId = null) => {
    // ✅ Encodear el UUID para manejar caracteres especiales como "/"
    const encodedUuid = encodeURIComponent(uuid);
    const params = occurrenceId ? { occurrence_id: occurrenceId } : {};
    return instance.get(`/api/clase/${encodedUuid}`, { params }).then(r => r.data);
  },
  
  getTranscript: (uuid, occurrenceId = null) => {
    // ✅ Encodear el UUID para manejar caracteres especiales como "/"
    const encodedUuid = encodeURIComponent(uuid);
    const params = occurrenceId ? { occurrence_id: occurrenceId } : {};
    return instance.get(`/api/transcript/${encodedUuid}`, { params }).then(r => r.data);
  }
}