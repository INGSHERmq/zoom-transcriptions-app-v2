// server.js - COMPLETO CON WEBHOOK DE TRANSCRIPCIONES Y CÁLCULO DE PUNTUALIDAD
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET;

// === MIDDLEWARE DE AUTENTICACIÓN (solo bloquea en producción) ===
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (process.env.NODE_ENV === 'production' && apiKey !== process.env.API_SECRET) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
};

// === TOKEN ZOOM CACHÉ ===
let cachedToken = null;
let tokenExpires = 0;

const getToken = async () => {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;

  const auth = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString("base64");
  const res = await axios.post(
    "https://zoom.us/oauth/token",
    `grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  cachedToken = res.data.access_token;
  tokenExpires = Date.now() + (res.data.expires_in - 300) * 1000;
  return cachedToken;
};

// === FUNCIÓN: Buscar ocurrencia más cercana ===
const findBestOccurrence = async (meetingId, occurrenceId, startTime) => {
  console.log(`🔍 Buscando mejor ocurrencia para meeting_id=${meetingId}`);
  
  if (occurrenceId) {
    const { data } = await supabase
      .from("classes")
      .select("*")
      .eq("zoom_meeting_id", String(meetingId))
      .eq("occurrence_id", String(occurrenceId))
      .maybeSingle();
    
    if (data) return data;
  }

  const { data: allOccurrences } = await supabase
    .from("classes")
    .select("*")
    .eq("zoom_meeting_id", String(meetingId))
    .order("scheduled_start", { ascending: true });

  if (!allOccurrences || allOccurrences.length === 0) return null;

  const pending = allOccurrences.filter(c => !c.actual_start && c.status === "scheduled");
  const candidates = pending.length > 0 ? pending : allOccurrences;
  const actualStart = new Date(startTime);
  
  let closest = candidates[0];
  let minDiff = Math.abs(new Date(candidates[0].scheduled_start) - actualStart);

  for (const occ of candidates) {
    const diff = Math.abs(new Date(occ.scheduled_start) - actualStart);
    if (diff < minDiff) {
      minDiff = diff;
      closest = occ;
    }
  }

  return closest;
};

// === ✅ FUNCIÓN: Calcular Puntualidad ===
const calculatePunctuality = (clase) => {
  const result = {
    start: { status: null, minutes: null, message: '—' },
    end: { status: null, minutes: null, message: '—' }
  };

  // === PUNTUALIDAD DE INICIO ===
  if (clase.delay_minutes !== null && clase.delay_minutes !== undefined) {
    const delay = clase.delay_minutes;
    
    if (delay > 0) {
      result.start = {
        status: 'late',
        minutes: delay,
        message: `Empezó ${delay} min tarde`
      };
    } else if (delay < 0) {
      result.start = {
        status: 'early',
        minutes: Math.abs(delay),
        message: `Empezó ${Math.abs(delay)} min antes`
      };
    } else {
      result.start = {
        status: 'on_time',
        minutes: 0,
        message: 'Empezó a tiempo'
      };
    }
  }

  // === PUNTUALIDAD DE FIN ===
  try {
    if (clase.scheduled_start && clase.duration_minutes && clase.actual_end) {
      const scheduledStart = new Date(clase.scheduled_start);
      const scheduledEnd = new Date(scheduledStart.getTime() + clase.duration_minutes * 60000);
      const actualEnd = new Date(clase.actual_end);
      
      if (!isNaN(scheduledEnd.getTime()) && !isNaN(actualEnd.getTime())) {
        const diffMs = actualEnd - scheduledEnd;
        const diffMinutes = Math.round(diffMs / 60000);
        
        if (diffMinutes > 0) {
          result.end = {
            status: 'late',
            minutes: diffMinutes,
            message: `Terminó ${diffMinutes} min tarde`
          };
        } else if (diffMinutes < 0) {
          result.end = {
            status: 'early',
            minutes: Math.abs(diffMinutes),
            message: `Terminó ${Math.abs(diffMinutes)} min antes`
          };
        } else {
          result.end = {
            status: 'on_time',
            minutes: 0,
            message: 'Terminó a tiempo'
          };
        }
      }
    }
  } catch (err) {
    console.error('Error calculando puntualidad de fin:', err);
  }

  return result;
};

// === WEBHOOKS ===
app.post("/webhook", async (req, res) => {
  try {
    // Log del evento recibido
    console.log("📨 Webhook recibido:", req.body.event);
    
    const signature = req.headers["x-zm-signature"];
    const timestamp = req.headers["x-zm-request-timestamp"];
    const msg = `v0:${timestamp}:${req.rawBody}`;
    const hash = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(msg).digest("hex");
    const expected = `v0=${hash}`;

    // Validación de URL
    if (req.body.event === "endpoint.url_validation") {
      const hashValidate = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET)
        .update(req.body.payload.plainToken)
        .digest("hex");
      return res.json({ plainToken: req.body.payload.plainToken, encryptedToken: hashValidate });
    }

    if (signature !== expected) return res.status(401).send("Bad signature");

    const m = req.body.payload.object;

    // 1. REUNIÓN CREADA
    if (req.body.event === "meeting.created") {
      const token = await getToken();
      let detail;
      try {
        detail = await axios.get(`https://api.zoom.us/v2/meetings/${m.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } catch (err) {
        console.error("❌ Error obteniendo detalle de reunión creada:", err.response?.data || err.message);
        return res.status(200).send("OK - Skip detail");
      }

      const meeting = detail.data;
      let occurrences = [];

      if (meeting.occurrences && Array.isArray(meeting.occurrences) && meeting.occurrences.length > 0) {
        occurrences = meeting.occurrences;
      } else {
        occurrences = [{
          occurrence_id: null,
          start_time: meeting.start_time,
          duration: meeting.duration
        }];
      }

      for (const occ of occurrences) {
        let startTimeIso = null;

        if (occ.start_time) {
          let timeStr = String(occ.start_time).trim();
          if (timeStr && !timeStr.endsWith('Z') && !timeStr.endsWith('+00:00')) {
            timeStr += 'Z';
          }
          startTimeIso = timeStr;
        } else if (meeting.start_time) {
          let timeStr = String(meeting.start_time).trim();
          if (timeStr && !timeStr.endsWith('Z') && !timeStr.endsWith('+00:00')) {
            timeStr += 'Z';
          }
          startTimeIso = timeStr;
        }

        if (!startTimeIso || startTimeIso === 'Z') {
          console.warn(`⚠️ Saltando ocurrencia sin fecha válida - Meeting ID: ${meeting.id}, Occ ID: ${occ.occurrence_id || 'principal'}`);
          continue;
        }

        const durationMin = occ.duration || meeting.duration || 60;

        try {
          const { error } = await supabase.from("classes").upsert({
            zoom_meeting_id: String(meeting.id),
            zoom_uuid: meeting.uuid || null,
            occurrence_id: occ.occurrence_id || null,
            topic: meeting.topic || "Sin título",
            host_email: meeting.host_email || meeting.host_id || "desconocido",
            scheduled_start: startTimeIso,
            duration_minutes: durationMin,
            created_at: meeting.created_at || new Date().toISOString(),
            status: "scheduled"
          }, {
            onConflict: ["zoom_meeting_id", "occurrence_id"],
            ignoreDuplicates: false
          });

          if (error) {
            console.error("❌ Error upsert clase programada:", error);
          } else {
            console.log(`✓ Sesión PROGRAMADA guardada: "${meeting.topic}" | ${startTimeIso} | Dur: ${durationMin}min | Occ: ${occ.occurrence_id || 'principal'}`);
          }
        } catch (err) {
          console.error("❌ Excepción al guardar clase programada:", err.message);
        }
      }

      res.status(200).json({ status: "OK" });
      return;
    }

    // 2. REUNIÓN INICIADA
    if (req.body.event === "meeting.started") {
      const occurrenceId = m.occurrence_id ? String(m.occurrence_id) : null;
      const actualStart = new Date(m.start_time.endsWith('Z') ? m.start_time : m.start_time + 'Z');

      const existing = await findBestOccurrence(m.id, occurrenceId, actualStart);

      if (!existing) {
        const { data: inserted } = await supabase.from("classes").insert({
          zoom_meeting_id: String(m.id),
          zoom_uuid: m.uuid,
          occurrence_id: occurrenceId,
          topic: m.topic || "Sin título",
          host_email: m.host_email || m.host_id,
          scheduled_start: actualStart.toISOString(),
          actual_start: actualStart.toISOString(),
          status: "live",
          delay_minutes: 0,
          duration_minutes: m.duration || 60
        }).select();

        console.log(`✅ Clase iniciada (creada) id=${inserted[0]?.id}`);
      } else {
        const scheduled = new Date(existing.scheduled_start);
        const delayMinutes = Math.round((actualStart - scheduled) / 60000);

        await supabase
          .from("classes")
          .update({
            actual_start: actualStart.toISOString(),
            status: "live",
            delay_minutes: delayMinutes,
            zoom_uuid: m.uuid
          })
          .eq("id", existing.id);

        console.log(`✅ Clase iniciada (actualizada) delay: ${delayMinutes}min`);
      }
      
      res.status(200).json({ status: "OK" });
      return;
    }

    // 3. REUNIÓN FINALIZADA
    if (req.body.event === "meeting.ended") {
      const occurrenceId = m.occurrence_id ? String(m.occurrence_id) : null;
      
      let existing = null;
      if (m.uuid) {
        const { data } = await supabase
          .from("classes")
          .select("*")
          .eq("zoom_uuid", m.uuid)
          .eq("status", "live")
          .maybeSingle();
        existing = data;
      }

      if (!existing) {
        existing = await findBestOccurrence(m.id, occurrenceId, new Date());
      }

      if (!existing) {
        console.warn("⚠️ No se encontró la clase activa");
        return res.status(200).send("OK - Not found");
      }

      await supabase
        .from("classes")
        .update({
          actual_end: new Date().toISOString(),
          duration_minutes: m.duration || existing.duration_minutes || 0,
          status: "ended"
        })
        .eq("id", existing.id);

      console.log(`✅ Clase finalizada: ${existing.topic}`);
      
      res.status(200).json({ status: "OK" });
      return;
    }

    // 4. ✅ TRANSCRIPCIÓN COMPLETADA (NUEVO)
    if (req.body.event === "recording.transcript_completed") {
      console.log("=".repeat(80));
      console.log("📄 WEBHOOK: TRANSCRIPCIÓN COMPLETADA");
      console.log("=".repeat(80));
      console.log("📦 Payload completo:", JSON.stringify(req.body.payload, null, 2));
      
      const payload = req.body.payload.object;
      const meetingUuid = payload.uuid;
      const meetingId = payload.id || payload.meeting_id;
      const recordingFiles = payload.recording_files || [];
      
      console.log(`   UUID: ${meetingUuid}`);
      console.log(`   Meeting ID: ${meetingId}`);
      console.log(`   Host ID: ${payload.host_id}`);
      console.log(`   Topic: ${payload.topic}`);
      console.log(`   Archivos disponibles: ${recordingFiles.length}`);
      
      recordingFiles.forEach((f, idx) => {
        console.log(`   Archivo ${idx + 1}:`);
        console.log(`      - Tipo: ${f.file_type || f.recording_type}`);
        console.log(`      - Extensión: ${f.file_extension}`);
        console.log(`      - URL: ${f.download_url ? 'Disponible' : 'NO disponible'}`);
      });
      
      // Buscar archivo de transcripción (más flexible)
      const transcriptFile = recordingFiles.find(
        file => file.file_type === "TRANSCRIPT" || 
                file.recording_type === "audio_transcript" ||
                file.file_extension === "vtt"
      );
      
      if (!transcriptFile) {
        console.warn("⚠️ No se encontró archivo de transcripción en el webhook");
        console.log("Archivos recibidos:", recordingFiles.map(f => `${f.file_type || f.recording_type} (${f.file_extension})`).join(', '));
        return res.status(200).send("OK - No transcript file");
      }
      
      console.log(`   ✓ Archivo de transcripción encontrado:`);
      console.log(`      - Tipo: ${transcriptFile.file_type || transcriptFile.recording_type}`);
      console.log(`      - Extensión: ${transcriptFile.file_extension}`);
      console.log(`      - Tamaño: ${transcriptFile.file_size} bytes`);
      
      try {
        // Descargar la transcripción
        const token = await getToken();
        const downloadUrl = `${transcriptFile.download_url}?access_token=${token}`;
        
        console.log(`   📥 Descargando transcripción desde Zoom...`);
        
        const transcriptRes = await axios.get(downloadUrl, {
          headers: { Authorization: `Bearer ${token}` },
          responseType: 'text'
        });
        
        const transcriptText = typeof transcriptRes.data === 'string' 
          ? transcriptRes.data 
          : JSON.stringify(transcriptRes.data);
        
        console.log(`   ✓ Transcripción descargada: ${transcriptText.length} caracteres`);
        console.log(`   Primeros 200 caracteres: ${transcriptText.substring(0, 200)}...`);
        
        // Buscar la clase en Supabase por UUID
        console.log(`   🔍 Buscando clase en Supabase con UUID: ${meetingUuid}`);
        
        const { data: clases, error: selectError } = await supabase
          .from("classes")
          .select("*")
          .eq("zoom_uuid", meetingUuid);
        
        if (selectError) {
          console.error("❌ Error buscando clase en Supabase:", selectError);
          return res.status(200).send("OK - DB Error");
        }
        
        if (!clases || clases.length === 0) {
          console.warn(`⚠️ No se encontró clase con UUID: ${meetingUuid}`);
          console.log(`   💡 Tip: Verifica que la reunión se haya iniciado correctamente y se guardó el UUID`);
          return res.status(200).send("OK - Class not found");
        }
        
        console.log(`   ✓ Encontradas ${clases.length} ocurrencia(s) para actualizar:`);
        clases.forEach(c => {
          console.log(`      - ID: ${c.id} | Topic: ${c.topic} | Meeting ID: ${c.zoom_meeting_id}`);
        });
        
        // Actualizar TODAS las ocurrencias con este UUID
        console.log(`   💾 Guardando transcripción en Supabase...`);
        
        const { error: updateError } = await supabase
          .from("classes")
          .update({
            transcription: transcriptText,
            updated_at: new Date().toISOString()
          })
          .eq("zoom_uuid", meetingUuid);
        
        if (updateError) {
          console.error("❌ Error guardando transcripción en Supabase:", updateError);
        } else {
          console.log(`✅✅✅ TRANSCRIPCIÓN GUARDADA EXITOSAMENTE ✅✅✅`);
          console.log(`   Actualizado ${clases.length} registro(s) en la base de datos`);
        }
        
      } catch (err) {
        console.error("❌ Error procesando transcripción:", err.message);
        if (err.response) {
          console.error("   Estado HTTP:", err.response.status);
          console.error("   Respuesta de error:", JSON.stringify(err.response.data, null, 2));
        }
        console.error("   Stack:", err.stack);
      }
      
      console.log("=".repeat(80));
      res.status(200).send("OK");
      return;
    }

    // Evento no manejado
    console.log(`ℹ️ Evento no manejado: ${req.body.event}`);
    res.status(200).json({ status: "OK - Event not handled" });
    
  } catch (e) {
    console.error("❌ ERROR WEBHOOK:", e.message);
    console.error(e.stack);
    res.status(500).json({ error: "Internal error" });
  }
});

// === DASHBOARD API ===
app.get("/api/meetings", async (req, res) => {
  try {
    const { data: all } = await supabase.from("classes").select("*").order("scheduled_start", { ascending: false });
    const now = new Date();

    const live = all.filter(c => c.status === "live");
    const ended = all.filter(c => c.status === "ended");
    const scheduled = all.filter(c => 
      c.status === "scheduled" && c.scheduled_start && new Date(c.scheduled_start) > now
    );
    const noAperturadas = all.filter(c => 
      c.status === "scheduled" && 
      c.scheduled_start && 
      new Date(c.scheduled_start) <= now && 
      !c.actual_start
    );

    res.json({ live, past: ended, scheduled, noAperturadas });
  } catch (err) {
    console.error("Error /api/meetings:", err);
    res.json({ live: [], past: [], scheduled: [], noAperturadas: [] });
  }
});

// === ENDPOINT: Detalle de clase CON PUNTUALIDAD ===
app.get("/api/clase/:uuid", async (req, res) => {
  try {
    const { uuid } = req.params;
    const { occurrence_id } = req.query;
    const decodedUuid = decodeURIComponent(uuid);

    console.log("=".repeat(80));
    console.log("🔍 GET /api/clase/:uuid");
    console.log("   UUID:", decodedUuid);
    console.log("   Occurrence ID:", occurrence_id || "NO ESPECIFICADO");
    console.log("=".repeat(80));

    let clase = null;

    if (occurrence_id) {
      console.log("   → Buscando por occurrence_id exacto...");
      const { data, error } = await supabase
        .from("classes")
        .select("*")
        .eq("zoom_uuid", decodedUuid)
        .eq("occurrence_id", occurrence_id)
        .maybeSingle();
      
      if (error) console.error("   ❌ Error Supabase:", error);
      clase = data;
      
      if (clase) {
        console.log(`   ✅ Encontrada por occurrence_id: ${clase.id}`);
      }
    } else {
      console.log("   → No hay occurrence_id, buscando primera ocurrencia por fecha...");
      const { data, error } = await supabase
        .from("classes")
        .select("*")
        .eq("zoom_uuid", decodedUuid)
        .order("scheduled_start", { ascending: true })
        .limit(1);
      
      if (error) {
        console.error("   ❌ Error Supabase:", error);
      }
      
      clase = data && data.length > 0 ? data[0] : null;
      
      if (clase) {
        console.log(`   ✅ Primera ocurrencia seleccionada: ID=${clase.id} | Occurrence=${clase.occurrence_id} | ${clase.scheduled_start}`);
      }
    }

    if (!clase) {
      console.log("   ❌ No se encontró ninguna clase");
      
      const { data: allOccurrences } = await supabase
        .from("classes")
        .select("id, occurrence_id, scheduled_start, status, topic")
        .eq("zoom_uuid", decodedUuid);
      
      console.log("📋 Ocurrencias disponibles para este UUID:");
      allOccurrences?.forEach(c => 
        console.log(`   - ID: ${c.id} | Occurrence: ${c.occurrence_id} | ${c.scheduled_start} | ${c.status}`)
      );
      
      return res.status(404).json({ 
        error: "Clase no encontrada",
        buscado: { uuid: decodedUuid, occurrence_id: occurrence_id || null },
        disponibles: allOccurrences
      });
    }

    // Calcular puntualidad
    const punctuality = calculatePunctuality(clase);

    const response = {
      ...clase,
      punctuality
    };

    console.log(`   ✅ RESPUESTA ENVIADA: ID=${clase.id}`);
    console.log(`   📊 Puntualidad calculada:`, punctuality);
    
    res.json(response);
    
  } catch (err) {
    console.error("❌ Error en /api/clase:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// === ✅ ENDPOINT MEJORADO: Transcripción ===
app.get("/api/transcript/:uuid", async (req, res) => {
  try {
    const { uuid } = req.params;
    const { occurrence_id } = req.query;
    const decodedUuid = decodeURIComponent(uuid);

    console.log("🔍 GET /api/transcript/:uuid");
    console.log("   UUID:", decodedUuid);
    console.log("   Occurrence ID:", occurrence_id || "NO ESPECIFICADO");

    // Buscar la clase en Supabase
    let query = supabase
      .from("classes")
      .select("*")
      .eq("zoom_uuid", decodedUuid);
    
    if (occurrence_id) {
      query = query.eq("occurrence_id", occurrence_id);
    }
    
    query = query.order("scheduled_start", { ascending: true }).limit(1);
    
    const { data: clases } = await query;
    const clase = clases && clases.length > 0 ? clases[0] : null;

    if (!clase) {
      console.log("   ❌ Clase no encontrada");
      return res.status(404).json({ 
        meeting: null, 
        transcript: null,
        error: "Clase no encontrada" 
      });
    }

    console.log(`   ✅ Clase encontrada: ID=${clase.id} | Meeting ID=${clase.zoom_meeting_id} | Status=${clase.status}`);

    // Si ya tiene transcripción → devolverla
    if (clase.transcription) {
      console.log(`   📄 Transcripción encontrada en BD (${clase.transcription.length} caracteres)`);
      return res.json({
        meeting: clase,
        transcript: clase.transcription
      });
    }

    // Si NO tiene transcripción → intentar buscar en Zoom (SOLO como fallback)
    console.log("   🔄 No hay transcripción en BD, intentando Zoom...");
    
    // Solo buscar si la reunión terminó hace más de 10 minutos
    if (clase.actual_end) {
      const endTime = new Date(clase.actual_end);
      const now = new Date();
      const minutesSinceEnd = (now - endTime) / 60000;
      
      if (minutesSinceEnd < 10) {
        console.log(`   ⏳ Reunión terminó hace ${Math.round(minutesSinceEnd)} min - esperando procesamiento`);
        return res.json({
          meeting: clase,
          transcript: null,
          message: "Transcripción procesándose (espera ~10 min después del fin)"
        });
      }
    }

    // Intentar descargar de Zoom (fallback)
    try {
      const token = await getToken();
      
      // ✅ MÉTODO 1: Usar el endpoint de recordings por UUID (el más directo)
      console.log(`   📡 MÉTODO 1: Intentando con UUID doble-encodeado...`);
      
      let recordingsRes;
      let metodUsado = null;
      
      // El UUID viene con == al final, que puede causar problemas
      // Intentar con doble encoding
      const doubleEncodedUuid = encodeURIComponent(encodeURIComponent(decodedUuid));
      
      try {
        console.log(`      UUID original: ${decodedUuid}`);
        console.log(`      UUID doble-encoded: ${doubleEncodedUuid}`);
        
        recordingsRes = await axios.get(
          `https://api.zoom.us/v2/meetings/${doubleEncodedUuid}/recordings`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        metodUsado = "UUID doble-encoded";
        console.log(`   ✓ ${metodUsado} funcionó!`);
      } catch (err1) {
        console.log(`      ✗ UUID doble-encoded falló: ${err1.response?.status || err1.message}`);
        
        // ✅ MÉTODO 2: Intentar con Meeting ID
        if (clase.zoom_meeting_id) {
          try {
            console.log(`   📡 MÉTODO 2: Intentando con Meeting ID: ${clase.zoom_meeting_id}`);
            recordingsRes = await axios.get(
              `https://api.zoom.us/v2/meetings/${clase.zoom_meeting_id}/recordings`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            metodUsado = "Meeting ID";
            console.log(`   ✓ ${metodUsado} funcionó!`);
          } catch (err2) {
            console.log(`      ✗ Meeting ID falló: ${err2.response?.status || err2.message}`);
            
            // ✅ MÉTODO 3: Buscar en todos los recordings del host
            console.log(`   📡 MÉTODO 3: Buscando en recordings del host...`);
            
            if (!clase.host_email) {
              throw new Error("No hay host_email para buscar recordings");
            }
            
            // Calcular fecha de la reunión
            const meetingDate = new Date(clase.actual_end || clase.scheduled_start);
            const fromDate = new Date(meetingDate);
            fromDate.setDate(fromDate.getDate() - 1); // 1 día antes
            const toDate = new Date(meetingDate);
            toDate.setDate(toDate.getDate() + 1); // 1 día después
            
            console.log(`      Host: ${clase.host_email}`);
            console.log(`      Rango: ${fromDate.toISOString().split('T')[0]} a ${toDate.toISOString().split('T')[0]}`);
            
            const userRecordingsRes = await axios.get(
              `https://api.zoom.us/v2/users/${encodeURIComponent(clase.host_email)}/recordings`,
              {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                  from: fromDate.toISOString().split('T')[0],
                  to: toDate.toISOString().split('T')[0]
                }
              }
            );
            
            const meetings = userRecordingsRes.data.meetings || [];
            console.log(`      Encontradas ${meetings.length} reuniones en ese rango`);
            
            // Buscar la reunión específica por UUID o Meeting ID
            const targetMeeting = meetings.find(m => 
              m.uuid === decodedUuid || 
              String(m.id) === String(clase.zoom_meeting_id)
            );
            
            if (!targetMeeting) {
              console.log(`      ✗ No se encontró la reunión específica`);
              meetings.forEach(m => {
                console.log(`         - UUID: ${m.uuid} | ID: ${m.id} | Topic: ${m.topic}`);
              });
              throw new Error("Reunión no encontrada en recordings del host");
            }
            
            console.log(`      ✓ Reunión encontrada: ${targetMeeting.topic}`);
            recordingsRes = { data: targetMeeting };
            metodUsado = "Recordings del host";
          }
        } else {
          throw err1;
        }
      }

      console.log(`   ✓ Respuesta de recordings obtenida con: ${metodUsado}`);
      
      const recordingFiles = recordingsRes.data.recording_files || [];
      console.log(`   📁 Archivos encontrados: ${recordingFiles.length}`);
      recordingFiles.forEach(f => {
        console.log(`      - ${f.file_type || f.recording_type} (${f.file_extension || 'N/A'})`);
      });
      
      const transcriptFile = recordingFiles.find(
        file => file.file_type === "TRANSCRIPT" || 
                file.recording_type === "audio_transcript" ||
                file.file_extension === "vtt"
      );

      if (transcriptFile?.download_url) {
        console.log(`   📥 Descargando transcripción desde: ${transcriptFile.file_type}`);
        
        const downloadUrl = `${transcriptFile.download_url}?access_token=${token}`;
        const transcriptRes = await axios.get(downloadUrl, {
          headers: { Authorization: `Bearer ${token}` },
          responseType: 'text'
        });

        const transcriptText = typeof transcriptRes.data === 'string'
          ? transcriptRes.data
          : JSON.stringify(transcriptRes.data);

        console.log(`   ✓ Transcripción descargada: ${transcriptText.length} caracteres`);

        // Guardar en Supabase
        const { error: updateError } = await supabase
          .from("classes")
          .update({ 
            transcription: transcriptText,
            updated_at: new Date().toISOString()
          })
          .eq("id", clase.id);

        if (updateError) {
          console.error("   ❌ Error guardando en BD:", updateError);
        } else {
          console.log(`   ✅ Transcripción guardada exitosamente en BD`);
        }
        
        return res.json({
          meeting: { ...clase, transcription: transcriptText },
          transcript: transcriptText
        });
      } else {
        console.log("   ⚠️ No se encontró archivo de transcripción en los recordings");
      }
    } catch (err) {
      if (err.response?.status === 404) {
        console.log("   ⚠️ No hay recordings en Zoom (404) - quizás no se grabó en nube");
      } else if (err.response?.status === 400) {
        console.log("   ⚠️ Error 400 - Meeting ID o UUID inválido");
        console.log(`   Detalles: ${err.response?.data?.message || 'Sin detalles'}`);
      } else {
        console.warn("   ⚠️ Error descargando de Zoom:", err.message);
        if (err.response?.data) {
          console.warn("   Respuesta de error:", JSON.stringify(err.response.data));
        }
      }
    }

    // No hay transcripción disponible
    console.log("   📭 No hay transcripción disponible");
    res.json({
      meeting: clase,
      transcript: null,
      message: "Transcripción no disponible aún"
    });

  } catch (err) {
    console.error("❌ Error en /api/transcript:", err.message);
    res.status(500).json({ 
      meeting: null, 
      transcript: null, 
      error: err.message 
    });
  }
});

// === HEALTH CHECK ===
app.get("/health", async (req, res) => {
  try {
    await supabase.from('classes').select('id').limit(1);
    await getToken();
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: "error", error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`
🚀 BACKEND ZOOM TRANSCRIPT CON WEBHOOKS DE TRANSCRIPCIONES
=============================================================
📡 Puerto: ${PORT}
🔒 CORS: ${process.env.NODE_ENV === 'production' ? 'RESTRINGIDO' : 'DEVELOPMENT'}
📊 Health: http://localhost:${PORT}/health

✅ Webhooks disponibles:
   - meeting.created → Guardar clases programadas
   - meeting.started → Registrar inicio y delay
   - meeting.ended → Registrar fin
   - recording.transcript_completed → Guardar transcripción ✨

📡 Endpoints API:
   - GET /api/meetings → Lista de clases
   - GET /api/clase/:uuid → Detalle con puntualidad
   - GET /api/transcript/:uuid → Transcripción (desde BD o Zoom)
=============================================================
  `);
});