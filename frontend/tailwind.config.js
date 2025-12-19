// tailwind.config.js

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html",
    "./index.html", // por si está en la raíz
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}