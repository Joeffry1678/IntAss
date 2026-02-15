import os
import re
import glob
import traceback

import json
import hashlib
from datetime import datetime

from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document
from langchain_community.document_loaders import PyPDFLoader, Docx2txtLoader

from knowledge.sources.langchain_sources import LangChainSources




class InterviewBrain:
    def __init__(self, resources_folder: str):
        self.folder = resources_folder
        print(f"[knowledge] Initializing Local AI with folder: {self.folder}", flush=True)

        self.embeddings = HuggingFaceEmbeddings(
            model_name="sentence-transformers/all-MiniLM-L6-v2",
            model_kwargs={"device": "cpu"},
            encode_kwargs={"normalize_embeddings": True}
        )
        self.vector_db = None

    def _fingerprint_folder(self, folder: str) -> str:
        """
        Fast-ish fingerprint to detect changes.
        Uses relative path + size + mtime_ns for supported files.
        """
        h = hashlib.sha1()
        exts = {".pdf", ".docx", ".txt", ".md"}

        for root, _, files in os.walk(folder):
            for fn in files:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in exts:
                    continue

                p = os.path.join(root, fn)
                try:
                    st = os.stat(p)
                except OSError:
                    continue

                rel = os.path.relpath(p, folder).replace("\\", "/")
                h.update(rel.encode("utf-8", "ignore"))
                h.update(str(st.st_size).encode("ascii"))
                h.update(str(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))).encode("ascii"))

        return h.hexdigest()

    def save_cached_index(self, cache_dir: str, resources_folder: str):
        """
        Persists FAISS index + metadata to disk.
        """
        if self.vector_db is None:
            return False, "No vector DB in memory"

        os.makedirs(cache_dir, exist_ok=True)

        # FAISS persistence (langchain)
        self.vector_db.save_local(cache_dir)

        meta = {
            "schema": "intass_index_cache_v1",
            "resources_folder": os.path.abspath(resources_folder),
            "fingerprint": self._fingerprint_folder(resources_folder),
            "saved_at": datetime.utcnow().isoformat() + "Z",
        }
        with open(os.path.join(cache_dir, "index_meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)

        return True, "OK"

    def load_cached_index(self, cache_dir: str, resources_folder: str):
        """
        Loads FAISS index from disk if present and still matches folder fingerprint.
        Returns (ok, message, loaded_bool)
        """
        meta_path = os.path.join(cache_dir, "index_meta.json")
        if not os.path.isfile(meta_path):
            return True, "No cached index meta", False

        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            return False, "Cache meta is unreadable", False

        saved_folder = os.path.abspath(str(meta.get("resources_folder", "")))
        cur_folder = os.path.abspath(resources_folder)

        if not saved_folder or saved_folder != cur_folder:
            return True, "Cached index belongs to a different folder", False

        # fingerprint check (prevents loading stale index)
        cur_fp = self._fingerprint_folder(resources_folder)
        if meta.get("fingerprint") != cur_fp:
            return True, "Resources changed; cache is stale", False

        # Load FAISS (langchain)
        self.vector_db = FAISS.load_local(
            cache_dir,
            self.embeddings,
            allow_dangerous_deserialization=True
        )
        return True, "Loaded cached index", True


    def _clean_text(self, s: str) -> str:
        if not s:
            return ""

        s = s.replace("\x00", " ")
        s = s.replace("\r\n", "\n").replace("\r", "\n")

        # de-hyphenate: "net-\nwork" -> "network"
        s = re.sub(r"(\w)-\n(\w)", r"\1\2", s)

        # Join lines only if it's clearly a mid-sentence wrap:
        # - previous char is not sentence punctuation
        # - next char is lowercase
        # - not a bullet line
        s = re.sub(
            r"(?<!\n)(?<![.!?:])\n(?!\n)(?!\s*(●|•|\-)\s+)(?=[a-z])",
            " ",
            s
        )

        # Otherwise keep as paragraph break (turn remaining single newlines into double)
        s = re.sub(r"(?<!\n)\n(?!\n)", "\n\n", s)



        # normalize whitespace
        s = re.sub(r"[ \t]+", " ", s)
        s = re.sub(r"\n{3,}", "\n\n", s)

        # remove space before punctuation
        s = re.sub(r"\s+([,.;:!?])", r"\1", s)

        # --- structure fixes ---
        # newline before bullets
        s = re.sub(r"\s*(●|•)\s*", r"\n\1 ", s)

        # treat " - " as a bullet only when it looks like a list item
        s = re.sub(r"(?<!\w)\s-\s+", r"\n- ", s)

        # newline before common section headings
        s = re.sub(r"\s+(Key Differences|Usage Examples|Synonyms/Related Terms)\b", r"\n\n\1", s)

        # if a colon is immediately followed by a bullet, split
        s = re.sub(r":\s*(●|•)", r":\n\1", s)

        return s.strip()

    def index_resources(self, folder: str = None):
        folder = folder or self.folder
        if not folder or not os.path.isdir(folder):
            self.vector_db = None
            return False, f"Folder not found: {folder}"

        documents = []
        first_err = None

        # DOCX
        docx_files = glob.glob(os.path.join(folder, "**", "*.docx"), recursive=True)
        docx_files = [fp for fp in docx_files if not os.path.basename(fp).startswith("~$")]
        docx_ok = docx_fail = 0

        for fp in docx_files:
            try:
                docs = Docx2txtLoader(fp).load()
                if docs and (docs[0].page_content or "").strip():
                    documents += docs
                    docx_ok += 1
                else:
                    docx_fail += 1
                    if first_err is None:
                        first_err = f"Empty text from DOCX: {os.path.basename(fp)}"
            except Exception as e:
                docx_fail += 1
                if first_err is None:
                    first_err = f"{type(e).__name__}: {e} (file={os.path.basename(fp)})"
                print(f"[knowledge] DOCX failed: {fp} -> {type(e).__name__}: {e}", flush=True)
                print(traceback.format_exc(), flush=True)

        # TXT
        txt_files = glob.glob(os.path.join(folder, "**", "*.txt"), recursive=True)
        txt_ok = txt_fail = 0

        for fp in txt_files:
            try:
                with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                    text = (f.read() or "").strip()
                if text:
                    documents.append(Document(page_content=text, metadata={"source": fp}))
                    txt_ok += 1
                else:
                    txt_fail += 1
                    if first_err is None:
                        first_err = f"Empty text from TXT: {os.path.basename(fp)}"
            except Exception as e:
                txt_fail += 1
                if first_err is None:
                    first_err = f"{type(e).__name__}: {e} (file={os.path.basename(fp)})"

        # PDF
        pdf_files = glob.glob(os.path.join(folder, "**", "*.pdf"), recursive=True)
        pdf_ok = pdf_fail = 0

        for fp in pdf_files:
            try:
                docs = PyPDFLoader(fp).load()
                joined = "\n".join((d.page_content or "").strip() for d in (docs or []))
                if joined.strip():
                    documents += docs
                    pdf_ok += 1
                else:
                    pdf_fail += 1
                    if first_err is None:
                        first_err = f"Empty text from PDF: {os.path.basename(fp)}"
            except Exception as e:
                pdf_fail += 1
                if first_err is None:
                    first_err = f"{type(e).__name__}: {e} (file={os.path.basename(fp)})"
                print(f"[knowledge] PDF failed: {fp} -> {type(e).__name__}: {e}", flush=True)
                print(traceback.format_exc(), flush=True)

        # PPTX (optional)
        try:
            from langchain_community.document_loaders import DirectoryLoader, UnstructuredPowerPointLoader
            documents += DirectoryLoader(folder, glob="**/*.pptx", loader_cls=UnstructuredPowerPointLoader).load()
        except Exception as e:
            print(f"[knowledge] PPTX load failed/skipped: {e}", flush=True)

        if not documents:
            self.vector_db = None
            return False, (
                f"No readable resources found in: {folder} | "
                f"PDF files={len(pdf_files)} ok={pdf_ok} fail={pdf_fail} | "
                f"DOCX files={len(docx_files)} ok={docx_ok} fail={docx_fail} | "
                f"TXT files={len(txt_files)} ok={txt_ok} fail={txt_fail} | "
                f"first_err={first_err}"
            )

        # ✅ clean BEFORE splitting
        for d in documents:
            d.page_content = self._clean_text(d.page_content or "")

        splitter = RecursiveCharacterTextSplitter(chunk_size=900, chunk_overlap=120)
        chunks = splitter.split_documents(documents)

        # per-doc chunk ordering
        per_doc_counter = {}
        for c in chunks:
            c.metadata = dict(c.metadata or {})
            src = c.metadata.get("source", "Unknown Source")
            doc_id = src

            per_doc_counter.setdefault(doc_id, 0)
            c.metadata["chunk_id"] = per_doc_counter[doc_id]
            per_doc_counter[doc_id] += 1

            c.metadata["source_basename"] = os.path.basename(src)
            c.metadata.setdefault("page", None)
            c.metadata["doc_id"] = doc_id

        if not chunks:
            self.vector_db = None
            return False, f"Loaded docs but produced 0 chunks from: {folder}"

        self.vector_db = FAISS.from_documents(chunks, self.embeddings)

        return True, (
            f"Indexed {len(chunks)} chunks from {len(documents)} docs | "
            f"PDF files={len(pdf_files)} ok={pdf_ok} fail={pdf_fail} | "
            f"DOCX files={len(docx_files)} ok={docx_ok} fail={docx_fail} | "
            f"TXT files={len(txt_files)} ok={txt_ok} fail={txt_fail}"
        )
        
    def _norm_for_dedupe(self, s: str) -> str:
        s = (s or "").strip().lower()
        s = re.sub(r"\s+", " ", s)
        s = re.sub(r"[^\w\s]", "", s)
        return s

    def _best_anchor_pos(self, text: str, query: str) -> int:
        """Find best anchor position inside text: exact query OR any keyword/bonus term."""
        t = (text or "")
        tl = t.lower()
        ql = (query or "").lower().strip()

        if not t or not ql:
            return -1

        # exact phrase
        i = tl.find(ql)
        if i != -1:
            return i

        # keyword anchors
        q_words = [w for w in re.findall(r"[a-z0-9]+", ql) if len(w) >= 4]
        bonus = ["work history", "experience", "employment", "career",
                 "ping", "tracert", "traceroute", "ipconfig", "ifconfig", "nslookup",
                 "netstat", "route", "arp", "telnet", "curl", "powershell", "cmd", "terminal", "cli"]

        anchors = []
        for w in q_words:
            pos = tl.find(w)
            if pos != -1:
                anchors.append(pos)

        for b in bonus:
            pos = tl.find(b)
            if pos != -1:
                anchors.append(pos)

        return min(anchors) if anchors else -1

    def _trim_around_query(self, text: str, query: str, window: int = 380) -> str:
        t = (text or "").strip()
        if not t:
            return ""

        pos = self._best_anchor_pos(t, query)
        if pos == -1:
            # fallback: small excerpt only (never dump huge chunk)
            limit = window * 2
            return t[:limit].strip() + ("…" if len(t) > limit else "")

        start = max(0, pos - window)
        end = min(len(t), pos + window)
        return ("…" if start > 0 else "") + t[start:end].strip() + ("…" if end < len(t) else "")

    def _query_terms(self, query: str):
        q = (query or "").lower()
        # keep words and numbers
        words = re.findall(r"[a-z0-9]+", q)

        stop = {
            "the", "and", "or", "to", "of", "in", "a", "an", "is", "are", "was", "were",
            "how", "what", "why", "when", "where", "who", "which", "do", "does", "did",
            "for", "with", "on", "at", "from", "by", "as", "it", "this", "that"
        }

        terms = [w for w in words if len(w) >= 3 and w not in stop]
        phrase = q.strip()
        return phrase, terms

    def _term_hit_count(self, text: str, terms: list[str]) -> int:
        t = (text or "").lower()
        if not t or not terms:
            return 0
        return sum(1 for w in set(terms) if w in t)

    def _min_required_hits(self, terms: list[str]) -> int:
        if not terms:
            return 0
        if len(terms) <= 3:
            return 2
        if len(terms) <= 6:
            return 3
        return 4


    def _matches_terms(self, text: str, phrase: str, terms: list[str]) -> bool:
        t = (text or "").lower()
        if not t:
            return False

        # exact phrase wins
        if phrase and phrase in t:
            return True

        hits = self._term_hit_count(t, terms)
        return hits >= self._min_required_hits(terms)



    def _extract_bracket_hits(self, text: str, phrase: str, terms: list[str]) -> str:
        """
        If query matches inside [...] return only inside-bracket content (brackets removed).
        """
        t = text or ""
        hits = []
        for m in re.finditer(r"\[(.+?)\]", t, flags=re.DOTALL):
            inside = (m.group(1) or "").strip()
            if inside and self._matches_terms(inside, phrase, terms):
                # collapse whitespace a bit but keep paragraphs
                inside = re.sub(r"[ \t]+", " ", inside)
                inside = re.sub(r"\n{3,}", "\n\n", inside).strip()
                hits.append(inside)

        if not hits:
            return ""

        # If multiple bracket matches, return them separated (still “only bracket content” rule)
        out = "\n\n".join(hits).strip()
        return out[:1800]

    def _extract_numbered_block(self, text: str, phrase: str, terms: list[str]) -> str:
        """
        Matches:
          1. ...
          1) ...
          1️⃣ ...
        Returns ONLY that block (stops before next item).
        """
        t = text or ""

        pat = r"(?ms)^\s*(?:\d+[\.\)]|\d+️⃣)\s+.*?(?=^\s*(?:\d+[\.\)]|\d+️⃣)\s+|\Z)"
        for m in re.finditer(pat, t):
            block = (m.group(0) or "").strip()
            if block and self._matches_terms(block, phrase, terms):
                return block[:6000].strip()

        return ""


    def _extract_step_block(self, text: str, phrase: str, terms: list[str]) -> str:
        """
        If query matches inside a Step block:
          Step 1: ...
          Step 2: ...
        return ONLY that step (stop before next Step or next numbered question).
        """
        t = text or ""

        pat = r"(?ms)^\s*Step\s*\d+\b.*?(?=^\s*Step\s*\d+\b|^\s*\d+[\.\)]\s+|\Z)"
        best = ""
        for m in re.finditer(pat, t):
            block = (m.group(0) or "").strip()
            if block and self._matches_terms(block, phrase, terms):
                best = block
                break

        return best[:6000].strip() if best else ""

    def _extract_by_rules(self, text: str, query: str) -> str:
        phrase, terms = self._query_terms(query)

        nb = self._extract_numbered_block(text, phrase, terms)
        if nb:
            return nb

        b = self._extract_bracket_hits(text, phrase, terms)
        if b:
            return b

        sb = self._extract_step_block(text, phrase, terms)
        if sb:
            return sb

        qb = self._extract_questionmark_block(text, phrase, terms)
        if qb:
            return qb

        # no structure matched -> return full context (bounded)
        return self._safe_trim(text, 6000)


    def _safe_trim(self, s: str, limit: int = 6000) -> str:
        s = (s or "").strip()
        if len(s) <= limit:
            return s
        cut = s.rfind("\n\n", 0, limit)  # prefer paragraph boundary
        if cut == -1:
            cut = s.rfind(". ", 0, limit)  # else sentence boundary
        if cut == -1:
            cut = limit
        return s[:cut].strip()


    def _extract_questionmark_block(self, text: str, phrase: str, terms: list[str]) -> str:
        """
        Rule:
        - Find the paragraph that contains '?' AND matches terms
        - Return from that paragraph up to (but NOT including) the next paragraph that contains '?'
        - Never include anything before the matching '?' paragraph
        """
        t = (text or "").strip()
        if not t:
            return ""

        # paragraphs = separated by blank lines
        paras = [p.strip() for p in re.split(r"\n{2,}", t) if p.strip()]
        if not paras:
            return ""

        start_idx = -1
        for i, p in enumerate(paras):
            if "?" in p and self._matches_terms(p, phrase, terms):
                start_idx = i
                break

        if start_idx == -1:
            return ""

        end_idx = len(paras)
        for j in range(start_idx + 1, len(paras)):
            if "?" in paras[j]:
                end_idx = j
                break

        out = "\n\n".join(paras[start_idx:end_idx]).strip()
        return out[:6000].strip()
        
        
    def _term_unique_and_freq(self, text: str, terms: list[str]) -> tuple[int, int]:
        """
        Returns:
          uniq_hits: number of DISTINCT query terms found in text
          freq_hits: total number of occurrences of all query terms in text
        """
        t = (text or "").lower()
        if not t or not terms:
            return 0, 0

        uniq = 0
        freq = 0
        for w in set(terms):
            # whole-word-ish match to avoid "ip" matching "ship"
            cnt = len(re.findall(rf"\b{re.escape(w)}\b", t))
            if cnt > 0:
                uniq += 1
                freq += cnt
        return uniq, freq




    def query(self, question: str) -> str:
        if not self.vector_db:
            return "Knowledge base not indexed. Please click 'Reload Resources'."

        q = (question or "").strip()
        if not q:
            return "Please enter a question."

        phrase, terms = self._query_terms(q)
        min_hits = self._min_required_hits(terms)

        scored = self.vector_db.similarity_search_with_score(q, k=80)
        scored = [(d, dist) for (d, dist) in (scored or []) if d and (d.page_content or "").strip()]
        if not scored:
            return "No matching information found in local resources."

        # STRICT FILTER: must contain enough query terms (or exact phrase)
        candidates = []
        for d, dist in scored:
            txt = d.page_content or ""
            tl = txt.lower()

            # strict: must match phrase OR enough UNIQUE hits
            uniq_hits, freq_hits = self._term_unique_and_freq(txt, terms)

            if (phrase and phrase in tl) or (uniq_hits >= min_hits):
                candidates.append((d, dist, uniq_hits, freq_hits))

        if not candidates:
            d0, dist0 = scored[0]
            combined_text = (d0.page_content or "").strip()
            answer = self._extract_by_rules(combined_text, q).strip() or self._trim_around_query(combined_text, q, window=240).strip()
            return self._safe_trim(answer, 6000)


        # BEST = most UNIQUE hits, then most frequency, then lowest distance
        candidates.sort(key=lambda x: (-x[2], -x[3], x[1]))
        best_d, best_dist, best_uniq, best_freq = candidates[0]


        best_src = best_d.metadata.get("source") or best_d.metadata.get("doc_id") or "Unknown Source"
        best_doc_id = best_d.metadata.get("doc_id") or best_src

        best_base = os.path.basename(best_src)

        # ✅ compute cid FIRST
        try:
            cid = int(best_d.metadata.get("chunk_id", 0))
        except Exception:
            cid = 0

        want_ids = {cid - 2, cid - 1, cid, cid + 1, cid + 2}

        # Expand neighbors from same doc (prevents partial block cut)
        all_docs = list(self.vector_db.docstore._dict.values())


        def same_doc(d):
            # prefer strict source match (most reliable)
            s1 = (best_d.metadata.get("source") or "").strip()
            s2 = (d.metadata.get("source") or "").strip()
            if s1 and s2 and s1 == s2:
                return True

            # fallback to doc_id match
            return (d.metadata.get("doc_id") or "").strip() == (best_d.metadata.get("doc_id") or "").strip()

        neighbors = [
            d for d in all_docs
            if same_doc(d)
            and int(d.metadata.get("chunk_id", -9999)) in want_ids
            and (d.page_content or "").strip()
        ]
        neighbors.sort(key=lambda d: int(d.metadata.get("chunk_id", 0)))

        combined_text = "\n\n".join((d.page_content or "").strip() for d in neighbors).strip()

        # optional but helps formatting after stitching chunks
        combined_text = self._clean_text(combined_text)

        answer = self._extract_by_rules(combined_text, q).strip()
        if not answer:
            answer = self._trim_around_query(combined_text, q, window=240).strip()

        # ✅ only ONE top answer, no filename prefix
        return answer[:6000]



        
    def _keyword_score(self, text: str, query: str, source_name: str = "") -> int:
        t = (text or "").lower()
        q = (query or "").lower()
        s = (source_name or "").lower()

        q_words = [w for w in re.findall(r"[a-z0-9]+", q) if len(w) >= 4]

        bonus = [
            "work history", "experience", "employment", "career",
            "ping", "tracert", "traceroute", "ipconfig", "ifconfig", "nslookup",
            "netstat", "route", "arp", "telnet", "curl", "powershell", "cmd", "terminal", "cli"
        ]

        score = 0

        # query keyword overlap (chunk text)
        for w in q_words:
            if w in t:
                score += 3

        # also score filename / doc name
        for w in q_words:
            if w in s:
                score += 5

        # bonus terms
        bonus_hits = 0
        for b in bonus:
            if b in t:
                score += 10
                bonus_hits += 1
            if b in s:
                score += 12  # filenames are strong signals

        # require CLI terms if user asked CLI
        wants_cli = any(x in q for x in ["command line", "cmd", "cli", "terminal"])
        if wants_cli and not any(x in t for x in ["ping", "tracert", "traceroute", "ipconfig", "ifconfig", "nslookup", "netstat", "route", "arp"]):
            score -= 80

        # require work-history-ish terms if user asked work history
        wants_history = any(x in q for x in ["work history", "employment", "career", "experience"])
        if wants_history and not any(x in t for x in ["work history", "experience", "employment", "career", "bpo", "cloudstaff", "mis", "freelance"]):
            score -= 80

        return score




