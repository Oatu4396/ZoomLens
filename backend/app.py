import asyncio
import json
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.engine.legacy import CalculationError, LegacyEngine

ROOT = Path(__file__).resolve().parent.parent


@asynccontextmanager
async def lifespan(app):
    if shutil.which('node') is None:
        raise RuntimeError('Node.js is required by the existing optical engine.')
    app.state.engine = LegacyEngine()
    yield


app = FastAPI(title='ZoomLens API', version='1.0.0', lifespan=lifespan)


@app.middleware('http')
async def revalidate_frontend(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-cache'
    return response


class CalculationRequest(BaseModel):
    document: dict[str, Any]


@app.get('/api/health')
async def health():
    return {'status': 'ok', 'engine': 'legacy-js'}


@app.post('/api/layout')
async def layout(body: CalculationRequest, request: Request):
    task = asyncio.create_task(app.state.engine.layout(body.document))
    try:
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                raise HTTPException(status_code=499, detail='Request cancelled.')
            await asyncio.sleep(0.05)
        return await task
    except CalculationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@app.post('/api/performance')
async def performance(body: CalculationRequest):
    async def records():
        try:
            async for result in app.state.engine.stream('performance', body.document):
                yield json.dumps(result, separators=(',', ':')) + '\n'
        except CalculationError as error:
            yield json.dumps({'error': str(error)}) + '\n'

    return StreamingResponse(records(), media_type='application/x-ndjson',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


app.mount('/shared', StaticFiles(directory=ROOT / 'shared'), name='shared')
app.mount('/', StaticFiles(directory=ROOT / 'frontend', html=True), name='frontend')
