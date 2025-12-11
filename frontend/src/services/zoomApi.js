import axios from 'axios'

const API = 'http://localhost:5000/api'

export const zoomApi = {
  getMeetings: async () => {
    const res = await axios.get(`${API}/meetings`)
    return res.data
  },
  getTranscript: async (uuid) => {
    const res = await axios.get(`${API}/meeting/${uuid}/transcript`)
    return res.data
  }
}