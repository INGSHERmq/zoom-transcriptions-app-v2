export const formatDate = (isoString) => {
  if (!isoString) return '—'
  return new Date(isoString).toLocaleString('es-ES', {
    dateStyle: 'short',
    timeStyle: 'short'
  })
}