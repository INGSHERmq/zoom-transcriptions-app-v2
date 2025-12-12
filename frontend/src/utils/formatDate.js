// src/utils/formatDate.js
import { parseISO, format } from 'date-fns';
import { es } from 'date-fns/locale';

export function formatDate(dateInput) {
  try {
    // Si no hay fecha, retornar placeholder
    if (!dateInput) return '—';

    // Si ya es un objeto Date válido, usarlo directamente
    if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
      return format(dateInput, "PPpp", { locale: es });
    }

    // Si es un string, parsearlo
    if (typeof dateInput === 'string') {
      const date = parseISO(dateInput);
      if (!isNaN(date.getTime())) {
        return format(date, "PPpp", { locale: es });
      }
    }

    // Si es un número (timestamp), convertirlo
    if (typeof dateInput === 'number') {
      const date = new Date(dateInput);
      if (!isNaN(date.getTime())) {
        return format(date, "PPpp", { locale: es });
      }
    }

    // Si llegamos aquí, la fecha no es válida
    console.warn('Fecha inválida:', dateInput);
    return '—';
    
  } catch (error) {
    console.error('Error formateando fecha:', error);
    console.error('Input recibido:', dateInput, 'Tipo:', typeof dateInput);
    return '—';
  }
}