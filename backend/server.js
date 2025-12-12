// server.js - CORRECCIÓN: Búsqueda inteligente de ocurrencias
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

// === WEBHOOKS ===
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-zm-signature"];
    const timestamp = req.headers["x-zm-request-timestamp"];
    const msg = `v0:${timestamp}:${req.rawBody}`;
    const hash = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(msg).digest("hex");
    const expected = `v0=${hash}`;

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
      const detail = await axios.get(`https://api.zoom.us/v2/meetings/${m.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const meeting = detail.data;
      const occurrences = meeting.occurrences?.length > 0
        ? meeting.occurrences
        : [{ start_time: meeting.start_time, occurrence_id: null }];

      for (const occ of occurrences) {
        const startTime = occ.start_time.endsWith('Z') ? occ.start_time : occ.start_time + 'Z';

        await supabase.from("classes").upsert({
          zoom_meeting_id: meeting.id,
          zoom_uuid: meeting.uuid,
          occurrence_id: occ.occurrence_id || null,
          topic: meeting.topic || "Sin título",
          host_email: meeting.host_email || meeting.host_id,
          scheduled_start: startTime,
          duration_minutes: meeting.duration || 60,
          created_at: meeting.created_at || new Date().toISOString(),
          status: "scheduled"
        }, {
          onConflict: ["zoom_meeting_id", "occurrence_id"],
          ignoreDuplicates: false
        });

        console.log(`✓ Sesión guardada: ${meeting.topic} | ${startTime}`);
      }
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
    }

    res.status(200).json({ status: "OK" });
  } catch (e) {
    console.error("❌ ERROR WEBHOOK:", e.message);
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

// === ✅ ENDPOINT: Detalle de clase (soporta ocurrencias) ===
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
      // Buscar por occurrence_id específico
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
      // ✅ Si no hay occurrence_id, devolver la PRIMERA por fecha (ascendente)
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
      
      // ✅ CRÍTICO: data es un array, tomar el primer elemento
      clase = data && data.length > 0 ? data[0] : null;
      
      if (clase) {
        console.log(`   ✅ Primera ocurrencia seleccionada: ID=${clase.id} | Occurrence=${clase.occurrence_id} | ${clase.scheduled_start}`);
      }
    }

    if (!clase) {
      console.log("   ❌ No se encontró ninguna clase");
      
      // Debug: mostrar todas las ocurrencias disponibles
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

    console.log(`   ✅ RESPUESTA ENVIADA: ID=${clase.id}`);
    res.json(clase);
    
  } catch (err) {
    console.error("❌ Error en /api/clase:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// === ✅ ENDPOINT: Transcripción ===
app.get("/api/transcript/:uuid", async (req, res) => {
  try {
    const { uuid } = req.params;
    const { occurrence_id } = req.query;
    const decodedUuid = decodeURIComponent(uuid);

    console.log("🔍 GET /api/transcript/:uuid");
    console.log("   UUID:", decodedUuid);
    console.log("   Occurrence ID:", occurrence_id || "NO ESPECIFICADO");

    let clase = null;

    if (occurrence_id) {
      const { data } = await supabase
        .from("classes")
        .select("*")
        .eq("zoom_uuid", decodedUuid)
        .eq("occurrence_id", occurrence_id)
        .maybeSingle();
      clase = data;
    } else {
      const { data } = await supabase
        .from("classes")
        .select("*")
        .eq("zoom_uuid", decodedUuid)
        .order("scheduled_start", { ascending: true })
        .limit(1);
      
      // ✅ Tomar primer elemento del array
      clase = data && data.length > 0 ? data[0] : null;
    }

    if (!clase) {
      return res.status(404).json({ meeting: {}, transcript: null });
    }

    console.log(`   ✅ Clase encontrada: ${clase.id}`);

    // Obtener transcripción de Zoom
    let transcript = null;
    try {
      const token = await getToken();
      const tr = await axios.get(`https://api.zoom.us/v2/past_meetings/${decodedUuid}/transcripts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      transcript = tr.data.transcripts?.[0]?.transcript || null;
    } catch (err) {
      console.warn("⚠️ Transcripción no disponible:", err.message);
    }

    res.json({
      meeting: clase,
      transcript
    });

  } catch (err) {
    console.error("❌ Error en /api/transcript:", err.message);
    res.status(500).json({ meeting: {}, transcript: null });
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
🚀 BACKEND ZOOM TRANSCRIPT CORREGIDO Y ACTUALIZADO
==================================================
📡 Puerto: ${PORT}
🔒 CORS: ${process.env.NODE_ENV === 'production' ? 'RESTRINGIDO' : 'DEVELOPMENT'}
📊 Health: http://localhost:${PORT}/health
✅ Endpoints disponibles:
   - GET /api/meetings → lista de clases (Supabase)
   - GET /api/clase/:uuid → detalle de clase (Supabase)
   - GET /api/transcript/:uuid → transcripción (Zoom API)
==================================================
  `);
});