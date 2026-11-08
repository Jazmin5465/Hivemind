"""HTTP service for the Hivemind backend. See docs/ML_CONTRACT.md.

    pip install fastapi uvicorn orjson lightgbm pandas numpy
    python ml/serve.py                      # http://localhost:8001
    uvicorn serve:app --app-dir ml --port 8001

Endpoints: GET /health, POST /detect, POST /explain. Errors are {"error": "..."}.
This service never reads answer_key.json.
"""
import sys
import time
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))

import orjson
import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response
from pydantic import BaseModel

import detector

app = FastAPI(title="Hivemind ML sidecar")


def _json(obj, status=200):
    return Response(orjson.dumps(obj, option=orjson.OPT_SERIALIZE_NUMPY), status_code=status,
                    media_type="application/json")


class DetectReq(BaseModel):
    datasetDir: str
    asOfUnix: Optional[int] = None


class ExplainReq(BaseModel):
    datasetDir: str
    assetId: str
    category: str
    onsetUnix: int
    asOfUnix: Optional[int] = None


def _err(msg, code):
    return _json({"error": str(msg)}, code)


@app.exception_handler(RequestValidationError)
async def _validation(_: Request, exc: RequestValidationError):
    return _err("; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()), 422)


@app.exception_handler(detector.DatasetError)
async def _dataset(_: Request, exc):
    return _err(exc, 400)


@app.exception_handler(Exception)
async def _any(_: Request, exc: Exception):
    return _err(f"{type(exc).__name__}: {exc}", 500)


@app.get("/health")
def health():
    m = detector.store().meta
    return _json({"status": "ok", "modelVersion": m["modelVersion"], "trainedOn": m["trainedOn"]})


@app.post("/detect")
def detect(req: DetectReq):
    t = time.time()
    out = detector.detect(req.datasetDir, req.asOfUnix)
    out["computeMs"] = int((time.time() - t) * 1000)     # extra field, ignorable
    return _json(out)


@app.post("/explain")
def explain(req: ExplainReq):
    return _json(detector.explain(req.datasetDir, req.assetId, req.category, req.onsetUnix, req.asOfUnix))


if __name__ == "__main__":
    detector.store()                      # fail fast if the model files are missing
    uvicorn.run(app, host="0.0.0.0", port=8001)
