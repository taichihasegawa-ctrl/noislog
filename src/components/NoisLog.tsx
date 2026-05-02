"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
// Types
// ============================================================
type CategoryKey = "footstep" | "running" | "door" | "impact" | "voice" | "music" | "other";
type DirectionKey = "above" | "side" | "unknown";
type PageKey = "monitor" | "records" | "settings";
type ModelStatus = "idle" | "loading" | "ready" | "error";

interface NoiseRecord {
  id: string;
  timestamp: number;
  category: CategoryKey;
  direction: DirectionKey;
  db: number;
  duration: number;
  memo: string;
  audioBlob?: string;
}

interface CategoryInfo {
  label: string;
  emoji: string;
  color: string;
}

interface DirectionInfo {
  label: string;
  emoji: string;
}

// ============================================================
// Constants
// ============================================================
const CATEGORIES: Record<CategoryKey, CategoryInfo> = {
  footstep: { label: "足音", emoji: "👣", color: "#F97316" },
  running: { label: "走る音", emoji: "🏃", color: "#EF4444" },
  door: { label: "ドア開閉", emoji: "🚪", color: "#8B5CF6" },
  impact: { label: "物を落とす音", emoji: "📦", color: "#EC4899" },
  voice: { label: "話し声", emoji: "🗣️", color: "#3B82F6" },
  music: { label: "音楽", emoji: "🎵", color: "#06B6D4" },
  other: { label: "その他", emoji: "❓", color: "#6B7280" },
};

const DIRECTIONS: Record<DirectionKey, DirectionInfo> = {
  above: { label: "上", emoji: "⬆️" },
  side: { label: "横", emoji: "➡️" },
  unknown: { label: "不明", emoji: "❔" },
};

// ============================================================
// IndexedDB
// ============================================================
const DB_NAME = "noislog";
const DB_VERSION = 1;
const STORE_NAME = "records";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveRecord(record: NoiseRecord) {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllRecords(): Promise<NoiseRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).index("timestamp").getAll();
    req.onsuccess = () => resolve((req.result as NoiseRecord[]).reverse());
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecordDB(id: string) {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllRecords() {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================
// Helpers
// ============================================================
function exportCSV(records: NoiseRecord[]) {
  const header = "日時,音の種類,方向,音量(dB),継続時間(秒),メモ\n";
  const rows = records.map((r) => {
    const date = new Date(r.timestamp).toLocaleString("ja-JP");
    const cat = CATEGORIES[r.category]?.label || r.category;
    const dir = DIRECTIONS[r.direction]?.label || r.direction;
    const memo = (r.memo || "").replace(/"/g, '""');
    return `"${date}","${cat}","${dir}",${r.db.toFixed(1)},${r.duration.toFixed(1)},"${memo}"`;
  });
  const csv = header + rows.join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `noislog_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

// Audio classification via spectral analysis
function classifyFromAnalyser(analyser: AnalyserNode, sampleRate: number): CategoryKey {
  const bufferLength = analyser.frequencyBinCount;
  const freqData = new Uint8Array(bufferLength);
  analyser.getByteFrequencyData(freqData);
  const binSize = sampleRate / (bufferLength * 2);

  let lowEnergy = 0, midEnergy = 0, highEnergy = 0, totalEnergy = 0;
  for (let i = 0; i < bufferLength; i++) {
    const freq = i * binSize;
    const val = freqData[i];
    totalEnergy += val;
    if (freq < 300) lowEnergy += val;
    else if (freq < 2000) midEnergy += val;
    else highEnergy += val;
  }
  if (totalEnergy === 0) return "other";

  const lowR = lowEnergy / totalEnergy;
  const midR = midEnergy / totalEnergy;
  const highR = highEnergy / totalEnergy;

  const timeData = new Uint8Array(bufferLength);
  analyser.getByteTimeDomainData(timeData);
  let zc = 0;
  for (let i = 1; i < timeData.length; i++) {
    if ((timeData[i] >= 128 && timeData[i - 1] < 128) || (timeData[i] < 128 && timeData[i - 1] >= 128)) zc++;
  }

  if (lowR > 0.55 && highR < 0.15) return zc > 50 ? "running" : "footstep";
  if (lowR > 0.45 && midR > 0.25 && zc < 30) return "door";
  if (midR > 0.45 && lowR < 0.35) return "voice";
  if (highR > 0.25 && midR > 0.3) return "music";
  if (lowR > 0.6) return "impact";
  return "other";
}

// ============================================================
// RecordCard Component
// ============================================================
function RecordCard({
  record, compact, editing, onEdit, onUpdate, onDelete,
}: {
  record: NoiseRecord;
  compact?: boolean;
  editing?: boolean;
  onEdit?: () => void;
  onUpdate?: (u: Partial<NoiseRecord>) => void;
  onDelete?: () => void;
}) {
  const cat = CATEGORIES[record.category] || CATEGORIES.other;
  const dir = DIRECTIONS[record.direction] || DIRECTIONS.unknown;
  const [memo, setMemo] = useState(record.memo || "");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    if (record.audioBlob) {
      fetch(record.audioBlob).then((r) => r.blob()).then((b) => setAudioUrl(URL.createObjectURL(b))).catch(() => {});
    }
    return () => { if (audioUrl) URL.revokeObjectURL(audioUrl); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.audioBlob]);

  return (
    <div style={{
      background: "rgba(255,255,255,0.03)", borderRadius: "12px",
      padding: compact ? "12px 14px" : "14px 16px", marginBottom: "8px",
      border: `1px solid ${editing ? "rgba(96,165,250,0.3)" : "rgba(255,255,255,0.06)"}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flex: 1 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: `${cat.color}20`, display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: 18, flexShrink: 0,
          }}>
            {cat.emoji}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: cat.color }}>{cat.label}</span>
              <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.06)", color: "#94a3b8" }}>
                {dir.emoji} {dir.label}
              </span>
              <span style={{ fontSize: 11, color: "#64748b" }}>{Math.round(record.db)}dB</span>
              <span style={{ fontSize: 11, color: "#64748b" }}>{record.duration.toFixed(1)}秒</span>
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
              {formatTime(record.timestamp)}
              {record.memo && <span style={{ marginLeft: 8, color: "#94a3b8" }}>💬 {record.memo}</span>}
            </div>
          </div>
        </div>
        {!compact && (
          <button onClick={onEdit} style={{ background: "none", border: "none", color: "#64748b", fontSize: 16, cursor: "pointer", padding: 4 }}>
            ✏️
          </button>
        )}
      </div>

      {editing && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          {audioUrl && (
            <audio controls src={audioUrl} style={{ width: "100%", height: 32, marginBottom: 10, borderRadius: 8 }} />
          )}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>音の種類</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(Object.entries(CATEGORIES) as [CategoryKey, CategoryInfo][]).map(([key, val]) => (
                <button key={key} onClick={() => onUpdate?.({ category: key })} style={{
                  padding: "4px 10px", borderRadius: 6,
                  border: `1px solid ${record.category === key ? val.color : "rgba(255,255,255,0.1)"}`,
                  background: record.category === key ? `${val.color}20` : "transparent",
                  color: record.category === key ? val.color : "#94a3b8", fontSize: 12, cursor: "pointer",
                }}>
                  {val.emoji} {val.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>方向</div>
            <div style={{ display: "flex", gap: 6 }}>
              {(Object.entries(DIRECTIONS) as [DirectionKey, DirectionInfo][]).map(([key, val]) => (
                <button key={key} onClick={() => onUpdate?.({ direction: key })} style={{
                  padding: "4px 14px", borderRadius: 6,
                  border: `1px solid ${record.direction === key ? "#60a5fa" : "rgba(255,255,255,0.1)"}`,
                  background: record.direction === key ? "rgba(96,165,250,0.15)" : "transparent",
                  color: record.direction === key ? "#60a5fa" : "#94a3b8", fontSize: 12, cursor: "pointer",
                }}>
                  {val.emoji} {val.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>メモ</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="例: 特に激しかった"
                style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", color: "#e2e8f0", fontSize: 13, outline: "none" }} />
              <button onClick={() => onUpdate?.({ memo })} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "rgba(96,165,250,0.15)", color: "#60a5fa", fontSize: 13, cursor: "pointer" }}>
                保存
              </button>
            </div>
          </div>
          <button onClick={onDelete} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.05)", color: "#f87171", fontSize: 13, cursor: "pointer" }}>
            🗑 この記録を削除
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Main Component
// ============================================================
export default function NoisLog() {
  const [page, setPage] = useState<PageKey>("monitor");
  const [isListening, setIsListening] = useState(false);
  const [currentDb, setCurrentDb] = useState(-100);
  const [threshold, setThreshold] = useState(50);
  const [isRecording, setIsRecording] = useState(false);
  const [records, setRecords] = useState<NoiseRecord[]>([]);
  const [filter, setFilter] = useState({ category: "all", date: "" });
  const [modelStatus, setModelStatus] = useState<ModelStatus>("idle");
  const [editingId, setEditingId] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingStartRef = useRef(0);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRecordingRef = useRef(false);
  const peakDbRef = useRef(-100);
  const thresholdRef = useRef(threshold);

  useEffect(() => { thresholdRef.current = threshold; }, [threshold]);
  useEffect(() => { getAllRecords().then(setRecords); }, []);

  const stopRecordingFn = useCallback((analyser: AnalyserNode) => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    isRecordingRef.current = false;
    setIsRecording(false);
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  }, []);

  const startRecordingFn = useCallback((stream: MediaStream, analyser: AnalyserNode) => {
    isRecordingRef.current = true;
    setIsRecording(true);
    peakDbRef.current = -100;
    chunksRef.current = [];
    recordingStartRef.current = Date.now();

    const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const duration = (Date.now() - recordingStartRef.current) / 1000;
      if (duration < 0.5) return;

      const sampleRate = audioContextRef.current?.sampleRate || 44100;
      const category = classifyFromAnalyser(analyser, sampleRate);

      const record: NoiseRecord = {
        id: crypto.randomUUID(),
        timestamp: recordingStartRef.current,
        category,
        direction: "above",
        db: peakDbRef.current,
        duration,
        memo: "",
        audioBlob: await blobToBase64(blob),
      };
      await saveRecord(record);
      setRecords((prev) => [record, ...prev]);
    };
    mediaRecorderRef.current = mr;
    mr.start(500);
  }, []);

  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;

      setModelStatus("ready");
      setIsListening(true);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Float32Array(bufferLength);

      function monitor() {
        analyser.getFloatTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i] * dataArray[i];
        const rms = Math.sqrt(sum / bufferLength);
        const db = rms > 0 ? 20 * Math.log10(rms) + 94 : -100;
        setCurrentDb(db);

        const th = thresholdRef.current;
        if (db >= th && !isRecordingRef.current) {
          startRecordingFn(stream, analyser);
        }
        if (isRecordingRef.current) {
          if (db > peakDbRef.current) peakDbRef.current = db;
          if (db < th - 5) {
            if (!silenceTimerRef.current) {
              silenceTimerRef.current = setTimeout(() => stopRecordingFn(analyser), 2000);
            }
          } else {
            if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
          }
        }
        animFrameRef.current = requestAnimationFrame(monitor);
      }
      monitor();
    } catch {
      alert("マイクへのアクセスを許可してください");
    }
  }, [startRecordingFn, stopRecordingFn]);

  const stopListening = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioContextRef.current) audioContextRef.current.close();
    setIsListening(false);
    setIsRecording(false);
    isRecordingRef.current = false;
    setCurrentDb(-100);
  }, []);

  async function updateRecord(id: string, updates: Partial<NoiseRecord>) {
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    const updated = { ...rec, ...updates };
    setRecords((prev) => prev.map((r) => (r.id === id ? updated : r)));
    await saveRecord(updated);
  }

  async function removeRecord(id: string) {
    await deleteRecordDB(id);
    setRecords((prev) => prev.filter((r) => r.id !== id));
  }

  async function clearAll() {
    if (confirm("すべての記録を削除しますか？")) {
      await clearAllRecords();
      setRecords([]);
    }
  }

  const filteredRecords = records.filter((r) => {
    if (filter.category !== "all" && r.category !== filter.category) return false;
    if (filter.date) {
      const d = new Date(r.timestamp).toISOString().slice(0, 10);
      if (d !== filter.date) return false;
    }
    return true;
  });

  const todayCount = records.filter(
    (r) => new Date(r.timestamp).toDateString() === new Date().toDateString()
  ).length;

  const dbLevel = Math.max(0, Math.min(100, ((currentDb + 40) / 80) * 100));
  const dbColor = currentDb >= threshold ? "#EF4444" : currentDb >= threshold - 10 ? "#F97316" : "#22C55E";

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(145deg, #0a0a0f 0%, #111827 50%, #0f172a 100%)",
      color: "#e2e8f0",
      fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      {/* Header */}
      <div style={{
        padding: "16px 20px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(0,0,0,0.3)", backdropFilter: "blur(20px)",
        position: "sticky", top: 0, zIndex: 50,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{
              fontSize: 22, fontWeight: 700,
              background: "linear-gradient(135deg, #60a5fa, #a78bfa)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              margin: 0, letterSpacing: "-0.5px",
            }}>NoisLog</h1>
            <p style={{ fontSize: 11, color: "#64748b", margin: "2px 0 0" }}>騒音自動検知 &amp; AI分類</p>
          </div>
          <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: 3 }}>
            {([["monitor", "📡"], ["records", "📋"], ["settings", "⚙️"]] as [PageKey, string][]).map(([id, label]) => (
              <button key={id} onClick={() => setPage(id)} style={{
                padding: "6px 14px", borderRadius: 8, border: "none",
                background: page === id ? "rgba(96,165,250,0.2)" : "transparent",
                color: page === id ? "#60a5fa" : "#64748b", fontSize: 16, cursor: "pointer",
              }}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: "16px 20px 100px" }}>
        {/* ===== MONITOR ===== */}
        {page === "monitor" && (
          <div>
            <div style={{
              background: "rgba(255,255,255,0.03)", borderRadius: 16, padding: 24, marginBottom: 16,
              border: `1px solid ${isRecording ? "rgba(239,68,68,0.3)" : "rgba(255,255,255,0.06)"}`,
            }}>
              <div style={{ textAlign: "center", marginBottom: 20 }}>
                <div style={{ fontSize: 56, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: dbColor, lineHeight: 1 }}>
                  {isListening ? Math.round(Math.max(0, currentDb)) : "--"}
                </div>
                <div style={{ fontSize: 14, color: "#64748b", marginTop: 4 }}>dB</div>
              </div>
              <div style={{ height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden", marginBottom: 12, position: "relative" }}>
                <div style={{ height: "100%", width: `${dbLevel}%`, background: "linear-gradient(90deg, #22C55E, #F97316, #EF4444)", borderRadius: 4, transition: "width 0.1s" }} />
                <div style={{ position: "absolute", left: `${((threshold + 40) / 80) * 100}%`, top: -2, bottom: -2, width: 2, background: "#fff", opacity: 0.5 }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#64748b" }}>
                <span>しきい値: {threshold} dB</span>
                {isRecording && (
                  <span style={{ color: "#EF4444", display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#EF4444", animation: "pulse 1s infinite" }} />録音中
                  </span>
                )}
              </div>
            </div>

            <button onClick={isListening ? stopListening : startListening} style={{
              width: "100%", padding: 16, borderRadius: 14, border: "none",
              background: isListening ? "linear-gradient(135deg, #991b1b, #dc2626)" : "linear-gradient(135deg, #1e40af, #3b82f6)",
              color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer", marginBottom: 16,
              boxShadow: isListening ? "0 4px 24px rgba(220,38,38,0.3)" : "0 4px 24px rgba(59,130,246,0.3)",
            }}>
              {isListening ? "⏹ モニタリング停止" : "🎙 モニタリング開始"}
            </button>

            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <div style={{ flex: 1, padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", fontSize: 12 }}>
                <span style={{ color: "#64748b" }}>AI分類: </span>
                <span style={{ color: modelStatus === "ready" ? "#22C55E" : "#64748b" }}>
                  {modelStatus === "ready" ? "✅ 準備完了" : "待機中"}
                </span>
              </div>
              <div style={{ flex: 1, padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", fontSize: 12 }}>
                <span style={{ color: "#64748b" }}>今日の検知: </span>
                <span style={{ color: "#60a5fa", fontWeight: 600 }}>{todayCount}件</span>
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>最近の検知</h2>
                {records.length > 0 && (
                  <button onClick={() => setPage("records")} style={{ background: "none", border: "none", color: "#60a5fa", fontSize: 13, cursor: "pointer" }}>
                    すべて見る →
                  </button>
                )}
              </div>
              {records.length === 0 ? (
                <div style={{ padding: 32, textAlign: "center", color: "#475569", fontSize: 14, background: "rgba(255,255,255,0.02)", borderRadius: 12, border: "1px dashed rgba(255,255,255,0.08)" }}>
                  まだ記録がありません。<br />モニタリングを開始すると自動で検知します。
                </div>
              ) : (
                records.slice(0, 5).map((r) => <RecordCard key={r.id} record={r} compact />)
              )}
            </div>
          </div>
        )}

        {/* ===== RECORDS ===== */}
        {page === "records" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>
                記録一覧 <span style={{ color: "#64748b", fontSize: 14, fontWeight: 400 }}>({filteredRecords.length}件)</span>
              </h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => exportCSV(filteredRecords)} disabled={filteredRecords.length === 0}
                  style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", color: filteredRecords.length > 0 ? "#60a5fa" : "#475569", fontSize: 12, cursor: filteredRecords.length > 0 ? "pointer" : "default" }}>
                  📊 CSV
                </button>
                <button onClick={clearAll} disabled={records.length === 0}
                  style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.05)", color: records.length > 0 ? "#f87171" : "#475569", fontSize: 12, cursor: records.length > 0 ? "pointer" : "default" }}>
                  🗑 全削除
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              <select value={filter.category} onChange={(e) => setFilter((f) => ({ ...f, category: e.target.value }))}
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", color: "#e2e8f0", fontSize: 13, flex: 1, minWidth: 120 }}>
                <option value="all">すべての種類</option>
                {(Object.entries(CATEGORIES) as [CategoryKey, CategoryInfo][]).map(([key, val]) => (
                  <option key={key} value={key}>{val.emoji} {val.label}</option>
                ))}
              </select>
              <input type="date" value={filter.date} onChange={(e) => setFilter((f) => ({ ...f, date: e.target.value }))}
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", color: "#e2e8f0", fontSize: 13, flex: 1, minWidth: 120 }} />
              {(filter.category !== "all" || filter.date) && (
                <button onClick={() => setFilter({ category: "all", date: "" })}
                  style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: "rgba(239,68,68,0.1)", color: "#f87171", fontSize: 13, cursor: "pointer" }}>
                  ✕ クリア
                </button>
              )}
            </div>

            {filteredRecords.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "#475569", fontSize: 14 }}>
                {records.length === 0 ? "まだ記録がありません" : "条件に一致する記録がありません"}
              </div>
            ) : (
              Object.entries(
                filteredRecords.reduce<Record<string, NoiseRecord[]>>((acc, r) => {
                  const d = formatDate(r.timestamp);
                  if (!acc[d]) acc[d] = [];
                  acc[d].push(r);
                  return acc;
                }, {})
              ).map(([date, recs]) => (
                <div key={date} style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#64748b", marginBottom: 8, paddingBottom: 4, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    {date} ({recs.length}件)
                  </div>
                  {recs.map((r) => (
                    <RecordCard key={r.id} record={r} editing={editingId === r.id}
                      onEdit={() => setEditingId(editingId === r.id ? null : r.id)}
                      onUpdate={(u) => updateRecord(r.id, u)}
                      onDelete={() => removeRecord(r.id)} />
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {/* ===== SETTINGS ===== */}
        {page === "settings" && (
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 16 }}>設定</h2>
            <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 14, padding: 20, border: "1px solid rgba(255,255,255,0.06)", marginBottom: 16 }}>
              <label style={{ fontSize: 14, fontWeight: 500, marginBottom: 12, display: "block" }}>
                検知しきい値: {threshold} dB
              </label>
              <input type="range" min="20" max="80" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: "100%", accentColor: "#60a5fa" }} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginTop: 4 }}>
                <span>20 (敏感)</span><span>80 (鈍感)</span>
              </div>
              <p style={{ fontSize: 12, color: "#64748b", marginTop: 12, lineHeight: 1.6 }}>
                低くするとわずかな音でも検知します。環境に応じて調整してください。
              </p>
            </div>
            <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 14, padding: 20, border: "1px solid rgba(255,255,255,0.06)", marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>使い方</h3>
              <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.8 }}>
                1. 「モニタリング開始」をタップ<br />
                2. スマホを部屋に置いたまま放置<br />
                3. しきい値を超える音を自動検知＆録音<br />
                4. AIが音の種類を自動分類<br />
                5. 記録一覧で確認・編集・CSV出力<br /><br />
                💡 管理会社への相談時にCSV＋録音データを証拠として提出できます。
              </div>
            </div>
            <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 14, padding: 20, border: "1px solid rgba(255,255,255,0.06)" }}>
              <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>注意事項</h3>
              <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.8 }}>
                ・ブラウザのタブを開いたままにしてください<br />
                ・バッテリー消費が増えるため充電推奨<br />
                ・音の分類はスペクトル解析による推定です<br />
                ・分類が違う場合は手動で修正できます<br />
                ・録音データはブラウザ内（IndexedDB）に保存されます
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        select option { background: #1e293b; color: #e2e8f0; }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.7); }
      `}</style>
    </div>
  );
}
