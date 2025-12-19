// backend\server.js
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const cron = require("node-cron");
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

// === SUPERVISOR: Función para obtener start_url (privilegios de host) ===
const getSupervisorUrl = async (meetingId) => {
  if (!meetingId) return null;
  const token = await getToken();
  try {
    const res = await axios.get(`https://api.zoom.us/v2/meetings/${meetingId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    return res.data.start_url || null;
  } catch (err) {
    console.log(`❌ Error obteniendo supervisor_url para ${meetingId}: ${err.response?.status || err.message}`);
    return null;
  }
};

// === FUNCIÓN CENTRALIZADA: Descargar transcripción y video de Zoom ===
const downloadTranscriptAndVideoFromZoom = async (clase) => {
  const token = await getToken();
  console.log(`   📥 Buscando grabación: "${clase.topic}" (ID: ${clase.id})`);
  
  let recordingsRes;
  
  if (clase.zoom_uuid) {
    try {
      const doubleEncodedUuid = encodeURIComponent(encodeURIComponent(clase.zoom_uuid));
      recordingsRes = await axios.get(
        `https://api.zoom.us/v2/meetings/${doubleEncodedUuid}/recordings`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
    } catch (err) {
      console.log(`      ✗ UUID falló: ${err.response?.status || err.message}`);
    }
  }
  
  if (!recordingsRes && clase.zoom_meeting_id) {
    try {
      recordingsRes = await axios.get(
        `https://api.zoom.us/v2/meetings/${clase.zoom_meeting_id}/recordings`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
    } catch (err) {
      console.log(`      ✗ Meeting ID falló: ${err.response?.status || err.message}`);
    }
  }
  
  if (!recordingsRes && clase.host_email && clase.actual_end) {
    try {
      const meetingDate = new Date(clase.actual_end);
      const fromDate = new Date(meetingDate);
      fromDate.setDate(fromDate.getDate() - 1);
      const toDate = new Date(meetingDate);
      toDate.setDate(toDate.getDate() + 1);
      
      const userRecordingsRes = await axios.get(
        `https://api.zoom.us/v2/users/${encodeURIComponent(clase.host_email)}/recordings`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            from: fromDate.toISOString().split('T')[0],
            to: toDate.toISOString().split('T')[0]
          },
          timeout: 15000
        }
      );
      
      const meetings = userRecordingsRes.data.meetings || [];
      const targetMeeting = meetings.find(m => 
        m.uuid === clase.zoom_uuid || String(m.id) === String(clase.zoom_meeting_id)
      );
      
      if (targetMeeting) recordingsRes = { data: targetMeeting };
    } catch (err) {
      console.log(`      ✗ Host recordings falló`);
    }
  }
  
  if (!recordingsRes) throw new Error("No se pudo obtener recordings");
  
  const recordingFiles = recordingsRes.data.recording_files || [];
  
  const transcriptFile = recordingFiles.find(
    file => file.file_type === "TRANSCRIPT" || 
            file.recording_type === "audio_transcript" ||
            file.file_extension?.toLowerCase() === "vtt"
  );
  
  const videoFile = recordingFiles.find(
    file => file.file_type === "MP4" && file.recording_type?.includes("shared_screen")
  ) || recordingFiles.find(
    file => file.file_type === "MP4" && file.recording_type === "active_speaker"
  ) || recordingFiles.find(
    file => file.file_type === "MP4"
  );
  
  let transcriptText = null;
  let videoUrl = null;
  
  if (transcriptFile?.download_url) {
    const downloadUrl = `${transcriptFile.download_url}?access_token=${token}`;
    try {
      const transcriptRes = await axios.get(downloadUrl, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'text',
        timeout: 30000
      });
      transcriptText = typeof transcriptRes.data === 'string' ? transcriptRes.data : JSON.stringify(transcriptRes.data);
      console.log(`      ✅ Transcripción descargada: ${transcriptText.length} caracteres`);
    } catch (err) {
      console.log(`      ⚠️ Error descargando transcripción: ${err.message}`);
    }
  }
  
  if (videoFile?.download_url) {
    videoUrl = `${videoFile.download_url}?access_token=${token}`;
    console.log(`      🎥 Video MP4 encontrado (${videoFile.recording_type || 'desconocido'})`);
  }
  
  return { transcript: transcriptText, video_url: videoUrl };
};

// === CRON JOB: Backup SOLO para transcripciones y videos de clases terminadas ===
const downloadMissedTranscripts = async () => {
  console.log('\n🔄 [CRON BACKUP] Buscando grabaciones perdidas...\n');
  
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    
    const { data: missedClasses } = await supabase
      .from("classes")
      .select("*")
      .eq("status", "ended")
      .or(`transcription.is.null,video_url.is.null`)
      .or(`webhook_received.is.null,webhook_received.eq.false`)
      .gte("actual_end", thirtyDaysAgo.toISOString())
      .lte("actual_end", tenMinutesAgo.toISOString())
      .order("actual_end", { ascending: false })
      .limit(20);
    
    if (!missedClasses?.length) {
      console.log('   ✓ No hay clases pendientes\n');
      return;
    }
    
    console.log(`   📋 ${missedClasses.length} clases pendientes\n`);
    
    let updated = 0, notAvailable = 0, failed = 0;
    
    for (const clase of missedClasses) {
      try {
        console.log(`   🔍 "${clase.topic}" (ID: ${clase.id})`);
        const { transcript, video_url } = await downloadTranscriptAndVideoFromZoom(clase);
        
        if (transcript || video_url) {
          await supabase
            .from("classes")
            .update({ 
              transcription: transcript,
              video_url: video_url,
              webhook_received: false,
              updated_at: new Date().toISOString()
            })
            .eq("id", clase.id);
          updated++;
        } else {
          notAvailable++;
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (err) {
        failed++;
        console.error(`      ❌ Error: ${err.message}`);
      }
    }
    
    console.log(`\n📊 Actualizadas: ${updated} | No disponibles: ${notAvailable} | Fallidas: ${failed}\n`);
    
  } catch (err) {
    console.error('❌ [CRON] Error:', err.message);
  }
};

// === PROGRAMAR CRON JOB ===
cron.schedule('0 */6 * * *', downloadMissedTranscripts);
setTimeout(downloadMissedTranscripts, 2 * 60 * 1000);

// === FUNCIONES AUXILIARES ===
const findBestOccurrence = async (meetingId, occurrenceId, startTime) => {
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

  if (!allOccurrences?.length) return null;

  const pending = allOccurrences.filter(c => !c.actual_start && c.status === "scheduled");
  const candidates = pending.length > 0 ? pending : allOccurrences;
  const actualStart = new Date(startTime);
  
  return candidates.reduce((closest, occ) => {
    const diff = Math.abs(new Date(occ.scheduled_start) - actualStart);
    const minDiff = Math.abs(new Date(closest.scheduled_start) - actualStart);
    return diff < minDiff ? occ : closest;
  }, candidates[0]);
};

const calculatePunctuality = (clase) => {
  const result = {
    start: { status: null, minutes: null, message: '—' },
    end: { status: null, minutes: null, message: '—' }
  };

  if (clase.delay_minutes != null) {
    const delay = clase.delay_minutes;
    if (delay > 0) result.start = { status: 'late', minutes: delay, message: `Empezó ${delay} min tarde` };
    else if (delay < 0) result.start = { status: 'early', minutes: Math.abs(delay), message: `Empezó ${Math.abs(delay)} min antes` };
    else result.start = { status: 'on_time', minutes: 0, message: 'Empezó a tiempo' };
  }

  try {
    if (clase.scheduled_start && clase.duration_minutes && clase.actual_end) {
      const scheduledEnd = new Date(new Date(clase.scheduled_start).getTime() + clase.duration_minutes * 60000);
      const actualEnd = new Date(clase.actual_end);
      const diffMinutes = Math.round((actualEnd - scheduledEnd) / 60000);
      
      if (diffMinutes > 0) result.end = { status: 'late', minutes: diffMinutes, message: `Terminó ${diffMinutes} min tarde` };
      else if (diffMinutes < 0) result.end = { status: 'early', minutes: Math.abs(diffMinutes), message: `Terminó ${Math.abs(diffMinutes)} min antes` };
      else result.end = { status: 'on_time', minutes: 0, message: 'Terminó a tiempo' };
    }
  } catch (err) {}

  return result;
};

// === ENDPOINT TEMPORAL: Rellenar supervisor_url en clases live y scheduled existentes ===
app.get("/fix-supervisor-urls", async (req, res) => {
  try {
    const { data: classes } = await supabase
      .from("classes")
      .select("id, zoom_meeting_id, supervisor_url, status")
      .in("status", ["live", "scheduled"])
      .is("supervisor_url", null)
      .limit(50);

    if (!classes || classes.length === 0) {
      return res.json({ message: "Todas las clases live/scheduled ya tienen supervisor_url o no hay pendientes" });
    }

    let updated = 0;
    for (const clase of classes) {
      if (clase.zoom_meeting_id) {
        const url = await getSupervisorUrl(clase.zoom_meeting_id);
        if (url) {
          await supabase
            .from("classes")
            .update({ supervisor_url: url })
            .eq("id", clase.id);
          updated++;
          console.log(`✅ supervisor_url actualizado para clase ${clase.id} (${clase.status})`);
        }
      }
      await new Promise(r => setTimeout(r, 500)); // Evitar rate limit
    }

    res.json({ message: `¡Listo! ${updated} clases live/scheduled actualizadas con supervisor_url` });
  } catch (err) {
    console.error("Error en fix-supervisor-urls:", err);
    res.status(500).json({ error: err.message });
  }
});

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
        .update(req.body.payload.plainToken).digest("hex");
      return res.json({ plainToken: req.body.payload.plainToken, encryptedToken: hashValidate });
    }

    if (signature !== expected) return res.status(401).send("Bad signature");

    const m = req.body.payload.object;

    // REUNIÓN CREADA - Guardamos supervisor_url desde el principio
    if (req.body.event === "meeting.created") {
      const token = await getToken();
      const detail = await axios.get(`https://api.zoom.us/v2/meetings/${m.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const meeting = detail.data;
      const occurrences = meeting.occurrences?.length > 0 ? meeting.occurrences : [{
        occurrence_id: null,
        start_time: meeting.start_time,
        duration: meeting.duration
      }];

      for (const occ of occurrences) {
        let startTimeIso = occ.start_time || meeting.start_time;
        if (startTimeIso && !startTimeIso.endsWith('Z')) startTimeIso += 'Z';
        if (!startTimeIso || startTimeIso === 'Z') continue;

        const supervisor_url = meeting.start_url || null;

        await supabase.from("classes").upsert({
          zoom_meeting_id: String(meeting.id),
          zoom_uuid: meeting.uuid || null,
          occurrence_id: occ.occurrence_id || null,
          topic: meeting.topic || "Sin título",
          host_email: meeting.host_email || "desconocido",
          scheduled_start: startTimeIso,
          duration_minutes: occ.duration || meeting.duration || 60,
          status: "scheduled",
          supervisor_url: supervisor_url
        }, { onConflict: ["zoom_meeting_id", "occurrence_id"] });
      }
      return res.status(200).json({ status: "OK" });
    }

    // REUNIÓN INICIADA
    if (req.body.event === "meeting.started") {
      const actualStart = new Date(m.start_time.endsWith('Z') ? m.start_time : m.start_time + 'Z');
      const existing = await findBestOccurrence(m.id, m.occurrence_id, actualStart);

      if (!existing) {
        await supabase.from("classes").insert({
          zoom_meeting_id: String(m.id),
          zoom_uuid: m.uuid,
          occurrence_id: m.occurrence_id || null,
          topic: m.topic || "Sin título",
          host_email: m.host_email || m.host_id,
          scheduled_start: actualStart.toISOString(),
          actual_start: actualStart.toISOString(),
          status: "live",
          delay_minutes: 0
        });
      } else {
        const delayMinutes = Math.round((actualStart - new Date(existing.scheduled_start)) / 60000);
        await supabase.from("classes").update({
          actual_start: actualStart.toISOString(),
          status: "live",
          delay_minutes: delayMinutes,
          zoom_uuid: m.uuid
        }).eq("id", existing.id);
      }
      return res.status(200).json({ status: "OK" });
    }

    // REUNIÓN FINALIZADA
    if (req.body.event === "meeting.ended") {
      let existing = null;
      if (m.uuid) {
        const { data } = await supabase.from("classes").select("*")
          .eq("zoom_uuid", m.uuid).eq("status", "live").maybeSingle();
        existing = data;
      }
      if (!existing) existing = await findBestOccurrence(m.id, m.occurrence_id, new Date());
      if (!existing) return res.status(200).send("OK");

      await supabase.from("classes").update({
        actual_end: new Date().toISOString(),
        status: "ended"
      }).eq("id", existing.id);
      return res.status(200).json({ status: "OK" });
    }

    // TRANSCRIPCIÓN COMPLETADA
    if (req.body.event === "recording.transcript_completed") {
      console.log("📄 WEBHOOK: Grabación completada (transcripción y/o video)");
      
      const payload = req.body.payload.object;
      const meetingUuid = payload.uuid;
      const recordingFiles = payload.recording_files || [];
      
      const token = await getToken();
      
      const transcriptFile = recordingFiles.find(f => 
        f.file_type === "TRANSCRIPT" || 
        f.recording_type === "audio_transcript" || 
        f.file_extension?.toLowerCase() === "vtt"
      );
      
      const videoFile = recordingFiles.find(f => 
        f.file_type === "MP4" && f.recording_type?.includes("shared_screen")
      ) || recordingFiles.find(f => f.file_type === "MP4");
      
      let updates = {
        webhook_received: true,
        updated_at: new Date().toISOString()
      };
      
      if (transcriptFile?.download_url) {
        const downloadUrl = `${transcriptFile.download_url}?access_token=${token}`;
        try {
          const transcriptRes = await axios.get(downloadUrl, {
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'text'
          });
          updates.transcription = typeof transcriptRes.data === 'string' ? transcriptRes.data : JSON.stringify(transcriptRes.data);
          console.log(`      ✅ Transcripción guardada vía webhook`);
        } catch (err) {
          console.log(`      ⚠️ Error descargando transcripción vía webhook`);
        }
      }
      
      if (videoFile?.download_url) {
        updates.video_url = `${videoFile.download_url}?access_token=${token}`;
        console.log(`      🎥 Video guardado vía webhook`);
      }
      
      await supabase.from("classes").update(updates).eq("zoom_uuid", meetingUuid);
      
      return res.status(200).send("OK");
    }

    res.status(200).json({ status: "OK" });
  } catch (e) {
    console.error("❌ ERROR WEBHOOK:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// === API ENDPOINTS ===
app.get("/api/meetings", async (req, res) => {
  const { data: all } = await supabase.from("classes").select("*").order("scheduled_start", { ascending: false });
  const now = new Date();
  res.json({
    live: all.filter(c => c.status === "live"),
    past: all.filter(c => c.status === "ended"),
    scheduled: all.filter(c => c.status === "scheduled" && new Date(c.scheduled_start) > now),
    noAperturadas: all.filter(c => c.status === "scheduled" && new Date(c.scheduled_start) <= now && !c.actual_start)
  });
});

app.get("/api/clase/:uuid", async (req, res) => {
  const { occurrence_id } = req.query;
  const decodedUuid = decodeURIComponent(req.params.uuid);
  
  let query = supabase.from("classes").select("*").eq("zoom_uuid", decodedUuid);
  if (occurrence_id) query = query.eq("occurrence_id", occurrence_id);
  query = query.order("scheduled_start", { ascending: true }).limit(1);
  
  const { data } = await query;
  const clase = data?.[0];
  
  if (!clase) return res.status(404).json({ error: "Clase no encontrada" });
  
  res.json({ ...clase, punctuality: calculatePunctuality(clase) });
});

app.get("/api/transcript/:uuid", async (req, res) => {
  const { occurrence_id } = req.query;
  const decodedUuid = decodeURIComponent(req.params.uuid);
  
  let query = supabase.from("classes").select("*").eq("zoom_uuid", decodedUuid);
  if (occurrence_id) query = query.eq("occurrence_id", occurrence_id);
  query = query.order("scheduled_start", { ascending: true }).limit(1);
  
  const { data } = await query;
  let clase = data?.[0];
  
  if (!clase) return res.status(404).json({ meeting: null, transcript: null, video_url: null });
  
  if (clase.transcription || clase.video_url) {
    return res.json({ 
      meeting: clase, 
      transcript: clase.transcription, 
      video_url: clase.video_url 
    });
  }
  
  try {
    const { transcript, video_url } = await downloadTranscriptAndVideoFromZoom(clase);
    if (transcript || video_url) {
      await supabase.from("classes").update({ 
        transcription: transcript,
        video_url: video_url 
      }).eq("id", clase.id);
      
      clase.transcription = transcript;
      clase.video_url = video_url;
    }
  } catch (err) {
    console.error("Fallback download failed:", err.message);
  }
  
  res.json({ 
    meeting: clase, 
    transcript: clase.transcription, 
    video_url: clase.video_url 
  });
});

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
🚀 SISTEMA HÍBRIDO DE GRABACIONES ZOOM
==========================================
📡 Puerto: ${PORT}
🎥 Soporte para Video MP4 + Transcripción
✅ Webhook Principal: recording.transcript_completed
🔄 Cron Backup: Cada 6 horas (solo ended)
👤 Supervisor: start_url para live/scheduled
🔧 Fix manual: /fix-supervisor-urls (ejecutar una vez)
📊 Health: /health
==========================================
  `);
});