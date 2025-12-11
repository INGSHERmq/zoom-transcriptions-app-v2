import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login from "./components/Login.jsx";  
import Dashboard from "./components/Dashboard.jsx";  
import MeetingDetail from "./components/MeetingDetail.jsx"; 

function App() {
  const isLoggedIn = localStorage.getItem('zoom_logged') === 'true'

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={isLoggedIn ? <Dashboard /> : <Login />} />
        <Route path="/meeting/:uuid" element={<MeetingDetail />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App