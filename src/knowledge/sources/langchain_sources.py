import os, glob
from .base import DocumentSource

class LangChainSources(DocumentSource):
    def load(self, folder: str):
        docs = []

        # DOCX
        try:
            from langchain_community.document_loaders import Docx2txtLoader
            for fp in glob.glob(os.path.join(folder, "**", "*.docx"), recursive=True):
                if os.path.basename(fp).startswith("~$"):
                    continue
                docs += Docx2txtLoader(fp).load()
        except Exception:
            pass

        # PDF
        try:
            from langchain_community.document_loaders import PyPDFLoader
            for fp in glob.glob(os.path.join(folder, "**", "*.pdf"), recursive=True):
                docs += PyPDFLoader(fp).load()
        except Exception:
            pass

        # PPTX (optional)
        try:
            from langchain_community.document_loaders import DirectoryLoader, UnstructuredPowerPointLoader
            docs += DirectoryLoader(folder, glob="**/*.pptx", loader_cls=UnstructuredPowerPointLoader).load()
        except Exception:
            pass

        # TXT (no langchain)
        try:
            from langchain_core.documents import Document
            for fp in glob.glob(os.path.join(folder, "**", "*.txt"), recursive=True):
                with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                    t = (f.read() or "").strip()
                if t:
                    docs.append(Document(page_content=t, metadata={"source": fp}))
        except Exception:
            pass

        return [d for d in docs if (getattr(d, "page_content", "") or "").strip()]
