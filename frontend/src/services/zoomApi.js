// src/services/zoomApi.js
import axios from 'axios'

const API_BASE = 'https://ashley-nonrevenue-genny.ngrok-free.dev'

// Configuración de axios para ngrok
const axiosInstance = axios.create({
  baseURL: API_BASE,
  headers: {
    'ngrok-skip-browser-warning': 'true',  // ← ESTO EVITA LA PÁGINA DE ADVERTENCIA
    'Content-Type': 'application/json'
  }
})

export const zoomApi = {
  getMeetings: async () => {
    const res = await axiosInstance.get('/api/meetings')
    return res.data
  },

  getTranscript: async (uuid) => {
    const res = await axiosInstance.get(`/api/transcript/${encodeURIComponent(uuid)}`)
    return res.data
  }
}