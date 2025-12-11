export default function Login() {
  const handleLogin = () => {
    localStorage.setItem('zoom_logged', 'true')
    window.location.reload()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-12 rounded-2xl shadow-2xl text-center max-w-md w-full">
        <h1 className="text-4xl font-bold text-blue-700 mb-8">Mis Clases de Zoom</h1>
        <button
          onClick={handleLogin}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 px-8 rounded-xl text-xl transition transform hover:scale-105"
        >
          Iniciar Sesión
        </button>
        <p className="mt-6 text-gray-600 text-sm">
          (Login simulado – ya tienes acceso completo a Zoom)
        </p>
      </div>
    </div>
  )
}