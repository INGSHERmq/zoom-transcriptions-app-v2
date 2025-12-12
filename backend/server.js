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
  
  // 1. Si hay occurrence_id, buscar exacto
  if (occurrenceId) {
    const { data } = await supabase
      .from("classes")
      .select("*")
      .eq("zoom_meeting_id", String(meetingId))
      .eq("occurrence_id", String(occurrenceId))
      .maybeSingle();
    
    if (data) {
      console.log(`✓ Encontrada por occurrence_id exacto: ${occurrenceId}`);
      return data;
    }
  }

  // 2. Buscar todas las ocurrencias de esta reunión
  const { data: allOccurrences } = await supabase
    .from("classes")
    .select("*")
    .eq("zoom_meeting_id", String(meetingId))
    .order("scheduled_start", { ascending: true });

  if (!allOccurrences || allOccurrences.length === 0) {
    console.log(`❌ No hay registros para meeting_id=${meetingId}`);
    return null;
  }

  console.log(`📋 ${allOccurrences.length} ocurrencias encontradas`);

  // 3. Filtrar solo las que NO han iniciado aún
  const pending = allOccurrences.filter(c => !c.actual_start && c.status === "scheduled");
  
  if (pending.length === 0) {
    console.log(`⚠️ No hay ocurrencias pendientes, usando la más cercana de todas`);
    // Fallback: buscar la más cercana aunque ya haya iniciado
    const actualStart = new Date(startTime);
    let closest = allOccurrences[0];
    let minDiff = Math.abs(new Date(allOccurrences[0].scheduled_start) - actualStart);

    for (const occ of allOccurrences) {
      const diff = Math.abs(new Date(occ.scheduled_start) - actualStart);
      if (diff < minDiff) {
        minDiff = diff;
        closest = occ;
      }
    }
    console.log(`✓ Seleccionada (fallback): ${closest.scheduled_start} (id=${closest.id})`);
    return closest;
  }

  // 4. De las pendientes, elegir la más cercana a la hora actual
  const actualStart = new Date(startTime);
  let closest = pending[0];
  let minDiff = Math.abs(new Date(pending[0].scheduled_start) - actualStart);

  for (const occ of pending) {
    const diff = Math.abs(new Date(occ.scheduled_start) - actualStart);
    if (diff < minDiff) {
      minDiff = diff;
      closest = occ;
    }
  }

  console.log(`✓ Mejor coincidencia: ${closest.scheduled_start} (diff: ${Math.round(minDiff/60000)}min, id=${closest.id})`);
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

        console.log(`✓ Sesión guardada: ${meeting.topic} | ${startTime} | occ: ${occ.occurrence_id || 'única'}`);
      }

      console.log(`CLASE CREADA → ${meeting.topic} (${occurrences.length} sesiones)`);
    }

    // 2. REUNIÓN INICIADA - CON BÚSQUEDA INTELIGENTE
    if (req.body.event === "meeting.started") {
      const occurrenceId = m.occurrence_id ? String(m.occurrence_id) : null;
      
      console.log("=".repeat(80));
      console.log("📥 MEETING.STARTED");
      console.log("=".repeat(80));
      console.log(`🔍 meeting_id: ${m.id}`);
      console.log(`🔍 occurrence_id: ${occurrenceId || 'NO ENVIADO'}`);
      console.log(`🔍 uuid: ${m.uuid}`);
      console.log(`🔍 start_time: ${m.start_time}`);
      console.log("=".repeat(80));

      const actualStart = new Date(m.start_time.endsWith('Z') ? m.start_time : m.start_time + 'Z');

      // USAR BÚSQUEDA INTELIGENTE
      const existing = await findBestOccurrence(m.id, occurrenceId, actualStart);

      if (!existing) {
        console.log(`🆕 NO EXISTE → Creando registro (CASO EXCEPCIONAL)`);
        
        const scheduled = actualStart;
        const delayMinutes = 0;

        const { data: inserted, error: insertError } = await supabase.from("classes").insert({
          zoom_meeting_id: String(m.id),
          zoom_uuid: m.uuid,
          occurrence_id: occurrenceId,
          topic: m.topic || "Sin título",
          host_email: m.host_email || m.host_id,
          scheduled_start: scheduled.toISOString(),
          actual_start: actualStart.toISOString(),
          status: "live",
          delay_minutes: delayMinutes,
          duration_minutes: m.duration || 60
        }).select();

        if (insertError) {
          console.error("❌ Error insertando:", insertError);
        } else {
          console.log(`✅ CLASE INICIADA (creada) id=${inserted[0]?.id}`);
        }
      } else {
        console.log(`♻️ ACTUALIZANDO EXISTENTE id=${existing.id}`);
        
        const scheduled = new Date(existing.scheduled_start);
        const delayMinutes = Math.round((actualStart - scheduled) / 60000);

        const { error: updateError } = await supabase
          .from("classes")
          .update({
            actual_start: actualStart.toISOString(),
            status: "live",
            delay_minutes: delayMinutes,
            zoom_uuid: m.uuid
          })
          .eq("id", existing.id);

        if (updateError) {
          console.error("❌ Error actualizando:", updateError);
        } else {
          console.log(`✅ CLASE INICIADA (actualizada) - delay: ${delayMinutes}min`);
        }
      }
    }

    // 3. REUNIÓN FINALIZADA - CON BÚSQUEDA INTELIGENTE
    if (req.body.event === "meeting.ended") {
      const occurrenceId = m.occurrence_id ? String(m.occurrence_id) : null;
      
      console.log("=".repeat(80));
      console.log("🔚 MEETING.ENDED");
      console.log("=".repeat(80));
      console.log(`🔍 meeting_id: ${m.id}`);
      console.log(`🔍 occurrence_id: ${occurrenceId || 'NO ENVIADO'}`);
      console.log(`🔍 uuid: ${m.uuid}`);
      console.log("=".repeat(80));

      // BUSCAR POR UUID (más confiable para reuniones activas)
      let existing = null;

      if (m.uuid) {
        const { data } = await supabase
          .from("classes")
          .select("*")
          .eq("zoom_uuid", m.uuid)
          .eq("status", "live")
          .maybeSingle();

        if (data) {
          existing = data;
          console.log(`✓ Encontrada por UUID (status=live)`);
        }
      }

      // Fallback: buscar por meeting_id + occurrence_id
      if (!existing) {
        existing = await findBestOccurrence(m.id, occurrenceId, new Date());
      }

      if (!existing) {
        console.error("❌ NO SE ENCONTRÓ LA CLASE ACTIVA");
        return res.status(200).send("OK - Not found");
      }

      console.log(`📌 Finalizando clase: id=${existing.id}`);

      const { error: updateError } = await supabase
        .from("classes")
        .update({
          actual_end: new Date().toISOString(),
          duration_minutes: m.duration || existing.duration_minutes || 0,
          status: "ended"
        })
        .eq("id", existing.id);

      if (updateError) {
        console.error("❌ Error actualizando estado:", updateError);
      } else {
        console.log(`✅ CLASE FINALIZADA: ${existing.topic}`);
      }
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error("ERROR WEBHOOK:", e.message);
    if (e.response?.data) console.error(e.response.data);
    res.status(500).send("Error");
  }
});

// === DASHBOARD API ===
app.get("/api/meetings", async (req, res) => {
  try {
    const { data: all } = await supabase.from("classes").select("*").order("scheduled_start", { ascending: false });
    const now = new Date();

    const live = all.filter(c => c.status === "live");
    const ended = all.filter(c => c.status === "ended");
    const scheduled = all.filter(c => c.status === "scheduled" && c.scheduled_start && new Date(c.scheduled_start) > now);
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

// === TRANSCRIPCIÓN + DETALLE ===
app.get("/api/transcript/:uuid", async (req, res) => {
  try {
    const { uuid } = req.params;
    const decodedUuid = decodeURIComponent(uuid);
    const token = await getToken();

    const meetingRes = await axios.get(`https://api.zoom.us/v2/past_meetings/${decodedUuid}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const meeting = meetingRes.data;

    let transcript = null;
    try {
      const tr = await axios.get(`https://api.zoom.us/v2/past_meetings/${decodedUuid}/transcripts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      transcript = tr.data.transcripts?.[0]?.transcript || null;
    } catch (_) {}

    res.json({ meeting, transcript });
  } catch (err) {
    console.error("Error transcript:", err.message);
    res.status(500).json({ meeting: {}, transcript: null });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("");
  console.log("🚀 BACKEND CON BÚSQUEDA INTELIGENTE DE OCURRENCIAS");
  console.log(`http://localhost:${PORT}`);
  console.log("→ Prioriza ocurrencia más cercana si Zoom no envía occurrence_id");
  console.log("→ Evita duplicados en reuniones recurrentes");
  console.log("→ Usa UUID para finalizar clases activas");
  console.log("");
});