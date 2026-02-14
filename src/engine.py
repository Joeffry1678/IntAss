import time
import os
import sys
import json
import queue
import threading
import numpy as np
import pyaudiowpatch as pyaudio
from vosk import Model, KaldiRecognizer
from interview_brain import InterviewBrain
import knowledge
print("[DEBUG] knowledge.py loaded from:", knowledge.__file__, flush=True)
from dotenv import load_dotenv
from ai.provider_factory import create_ai_provider

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

ENV_PATH = os.path.abspath(os.path.join(BASE_DIR, "..", ".env"))
if os.path.isfile(ENV_PATH):
    load_dotenv(ENV_PATH)
    
print("[DEBUG ENV] ENV_PATH =", ENV_PATH, "exists =", os.path.isfile(ENV_PATH), flush=True)
print("[DEBUG ENV] GEMINI_MODEL =", os.environ.get("GEMINI_MODEL"), flush=True)


MODEL_PATH = (
    os.environ.get("INTASS_MODELS_DIR")
    or os.path.abspath(os.path.join(BASE_DIR, "..", "models", "model-en-us"))
)

RESOURCE_PATH = (
    os.environ.get("INTASS_RESOURCES_DIR")
    or os.path.abspath(os.path.join(BASE_DIR, "..", "resources"))
)

def emit(payload):
    print(json.dumps(payload), flush=True)

def status(text):
    emit({"type": "status", "text": text})

class IntAssEngine:
    def __init__(self):
        self.target_rate = 16000
        self.audio_q = queue.Queue()
        self.stop_event = threading.Event()
        self.running = False

        self.resource_path = os.path.abspath(RESOURCE_PATH)
        self.brain = None
        self.ai = create_ai_provider()

        status("Initializing knowledge base…")
        t0 = time.perf_counter()
        self._init_brain(self.resource_path)
        status(f"Knowledge init finished in {(time.perf_counter()-t0):.1f}s")


        try:
            status("Loading Vosk model…")

            if not os.path.isdir(MODEL_PATH):
                raise FileNotFoundError(f"Model folder not found: {MODEL_PATH}")

            t0 = time.perf_counter()
            self.model = Model(MODEL_PATH)
            dt = time.perf_counter() - t0

            status(f"Vosk model loaded in {dt:.1f}s")
        except Exception as e:


            emit({"type": "error", "message": f"Vosk Load Failed: {e}"})
            status(f"ERROR: Vosk Load Failed: {e}")
            sys.exit(1)

    def _init_brain(self, resources_folder: str):
        try:
            self.brain = InterviewBrain(resources_folder=resources_folder)
            status(f"Knowledge base ready: {resources_folder}")
        except Exception as e:
            self.brain = None
            emit({"type": "error", "message": f"Local Brain init failed: {e}"})
            status(f"ERROR: Brain init failed: {e}")

    def set_resources_folder(self, folder: str):
        try:
            if not folder:
                emit({"type": "error", "message": "No folder provided."})
                status("ERROR: No folder provided.")
                return

            folder = os.path.abspath(folder)

            if not os.path.isdir(folder):
                emit({"type": "error", "message": f"Folder does not exist: {folder}"})
                status(f"ERROR: Folder does not exist: {folder}")
                return

            self.resource_path = folder
            status(f"Resources folder set: {self.resource_path}")
            self._init_brain(self.resource_path)
            status("Resources updated. Ready to index.")
        except Exception as e:
            emit({"type": "error", "message": f"Failed to set resources folder: {e}"})
            status(f"ERROR: Failed to set resources folder: {e}")

    def list_devices(self):
        status("Scanning audio devices…")
        p = pyaudio.PyAudio()
        devices = []
        try:
            api = p.get_host_api_info_by_type(pyaudio.paWASAPI)
            for i in range(p.get_device_count()):
                d = p.get_device_info_by_index(i)
                if d["hostApi"] != api["index"]:
                    continue

                if d.get("maxInputChannels", 0) > 0:
                    devices.append({"id": i, "name": f"MIC: {d['name']}"})
                elif d.get("maxOutputChannels", 0) > 0:
                    devices.append({"id": i, "name": f"SYSTEM: {d['name']}"})
        finally:
            p.terminate()

        status(f"Audio devices loaded: {len(devices)}")
        return devices

    def find_loopback(self, p, sys_dev):
        base = sys_dev["name"].split(" (")[0]
        for i in range(p.get_device_count()):
            d = p.get_device_info_by_index(i)
            if d.get("maxInputChannels", 0) > 0:
                if "[Loopback]" in d["name"] and base in d["name"]:
                    return i
        return None

    def resample(self, audio, src_rate):
        if src_rate == self.target_rate:
            return audio
        audio = audio.astype(np.float32)
        n = len(audio)
        m = int(n * self.target_rate / src_rate)
        if m < 2:
            return audio.astype(np.int16)
        return np.interp(
            np.linspace(0, n - 1, m),
            np.linspace(0, n - 1, n),
            audio
        ).astype(np.int16)

    def stop(self):
        # ✅ request stop + unblock queue consumer
        self.stop_event.set()
        try:
            self.audio_q.put_nowait(b"")  # sentinel unblock
        except Exception:
            pass
        status("Stopping…")

    def index_knowledge(self):
        try:
            status("Indexing resources…")

            if not self.brain:
                self._init_brain(self.resource_path)
            if not self.brain:
                emit({"type": "error", "message": "Knowledge base not available (brain init failed)."})
                status("ERROR: Knowledge base not available.")
                return

            ok, msg = self.brain.index_resources()

            # ✅ only claim success if indexing actually built a DB
            if not ok or not getattr(self.brain, "vector_db", None):
                emit({"type": "error", "message": f"Indexing failed: {msg}"})
                status(f"ERROR: Indexing failed: {msg}")
                return

            status(f"Index complete: {self.resource_path}")
            emit({"type": "index_done", "path": self.resource_path})
            emit({"type": "status", "text": f"Local Knowledge Indexed: {self.resource_path}"})


        except Exception as e:
            emit({"type": "error", "message": f"Indexing failed: {e}"})
            status(f"ERROR: Indexing failed: {e}")

    def query_knowledge(self, question: str, ai_enabled: bool = True):
        try:
            status("Searching resources…")

            if not self.brain:
                self._init_brain(self.resource_path)
            if not self.brain:
                emit({"type": "error", "message": "Knowledge base not available (brain init failed)."})
                status("ERROR: Knowledge base not available.")
                return

            context = self.brain.query(question)

            emit({"type": "knowledge_context", "text": context})

            # --- AI answer (RAG -> LLM) ---
            # --- AI answer (RAG -> LLM) ---
            if ai_enabled:
                try:
                    ai_text = self.ai.answer(question, context)
                    emit({"type": "ai_result", "text": ai_text})
                except Exception as e:
                    msg = str(e)

                    # Friendly free-tier quota message
                    if ("429" in msg) and ("Quota exceeded" in msg or "exceeded your current quota" in msg):
                        emit({"type": "ai_error", "message": "AI quota reached (free tier). Try again tomorrow."})
                    else:
                        emit({"type": "ai_error", "message": f"AI generation failed: {msg}"})
            # -----------------------------



            status("Search complete.")
            emit({"type": "search_done"})


        except Exception as e:
            emit({"type": "error", "message": f"Search failed: {e}"})
            status(f"ERROR: Search failed: {e}")

    def start(self, device_id):
        # prevent double start
        if self.running:
            return

        self.stop_event.clear()
        self.running = True

        p = pyaudio.PyAudio()
        stream = None

        try:
            dev_id = int(device_id)
            info = p.get_device_info_by_index(dev_id)

            # if SYSTEM selected, map to its loopback MIC
            if info.get("maxInputChannels", 0) == 0:
                loop = self.find_loopback(p, info)
                if loop is None:
                    raise RuntimeError("No Loopback found for selected SYSTEM device")
                dev_id = loop
                info = p.get_device_info_by_index(dev_id)

            rate = int(info["defaultSampleRate"])
            chans = int(info["maxInputChannels"])

            rec = KaldiRecognizer(self.model, self.target_rate)
            rec.SetWords(True)

            def callback(in_data, *_):
                if self.stop_event.is_set():
                    return (None, pyaudio.paComplete)

                audio = np.frombuffer(in_data, np.int16)
                if chans > 1:
                    audio = audio.reshape(-1, chans).mean(axis=1).astype(np.int16)

                try:
                    self.audio_q.put_nowait(self.resample(audio, rate).tobytes())
                except Exception:
                    pass
                return (None, pyaudio.paContinue)

            stream = p.open(
                format=pyaudio.paInt16,
                channels=chans,
                rate=rate,
                input=True,
                input_device_index=dev_id,
                frames_per_buffer=4000,
                stream_callback=callback
            )

            status("AI LISTENING…")

            last = ""
            while not self.stop_event.is_set():
                try:
                    data = self.audio_q.get(timeout=0.25)
                except queue.Empty:
                    continue

                # sentinel from stop()
                if self.stop_event.is_set():
                    break

                if not data:
                    continue

                if rec.AcceptWaveform(data):
                    r = json.loads(rec.Result())
                    text = r.get("text", "")
                    if text:
                        emit({"type": "transcript", "text": text})
                        last = ""
                else:
                    ptxt = json.loads(rec.PartialResult()).get("partial", "")
                    if ptxt and ptxt != last:
                        emit({"type": "partial", "text": ptxt})
                        last = ptxt

        except OSError as e:
            # ✅ if stop was requested, ignore pyaudio host errors
            if self.stop_event.is_set():
                status("Stopped.")
            else:
                emit({"type": "error", "message": f"Engine Crash: {e}"})
                status(f"ERROR: Engine Crash: {e}")

        except Exception as e:
            if self.stop_event.is_set():
                status("Stopped.")
            else:
                emit({"type": "error", "message": f"Engine Crash: {e}"})
                status(f"ERROR: Engine Crash: {e}")

        finally:
            try:
                if stream:
                    try:
                        stream.stop_stream()
                    except Exception:
                        pass
                    try:
                        stream.close()
                    except Exception:
                        pass
            except Exception:
                pass

            try:
                p.terminate()
            except Exception:
                pass

            self.running = False
            self.stop_event.clear()
            status("Idle.")

def main():
    status("Booting engine…")
    engine = IntAssEngine()
    emit({"type": "status", "text": "Engine Ready"})

    for line in sys.stdin:
        try:
            msg = json.loads(line)
            cmd = msg.get("cmd")

            if cmd == "get_devices":
                emit({"type": "device_list", "devices": engine.list_devices()})

            elif cmd == "start":
                threading.Thread(target=engine.start, args=(msg.get("device_id"),), daemon=True).start()

            elif cmd == "stop":
                engine.stop()

            elif cmd == "index_knowledge":
                threading.Thread(target=engine.index_knowledge, daemon=True).start()

            elif cmd == "query_knowledge":
                threading.Thread(
                    target=engine.query_knowledge,
                    args=(msg.get("question", ""), msg.get("ai", True)),
                    daemon=True
                ).start()

            elif cmd == "set_resources":
                engine.set_resources_folder(msg.get("path", ""))

        except Exception:
            pass

if __name__ == "__main__":
    main()
