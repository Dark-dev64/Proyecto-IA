"""backend/main.py — API REST con FastAPI.

Este archivo solo ensambla la aplicación: crea los singletons (agentes) una
vez al arrancar, monta el frontend estático e incluye los routers. Toda la
lógica de endpoints vive en backend/routers/.
"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import GEMINI_API_KEY, FRONTEND_DIR
from backend.dependencies import cerrar_dependencies, init_dependencies

from backend.routers import info, pages, mercado, analisis, recomendaciones, conversacional, chat


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Se ejecuta una sola vez al arrancar: instancia todos los agentes
    # (MarketSensor, ExpertBrain, etc.) y los deja listos en dependencies.py
    print(f"✅ API Key de Gemini configurada correctamente")
    print(f"🔑 Key: {GEMINI_API_KEY[:10]}...")
    init_dependencies()
    yield
    await cerrar_dependencies()
    # (sin lógica de shutdown por ahora)


app = FastAPI(
    title="Agente BVL — API",
    description="Sistema Experto de Inversiones · UPAO 2026",
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS ──
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Frontend estático ──
# El HTML pide rutas en la raíz: /css/base.css, /js/chat.js, etc.
# Montamos /css y /js directamente en sus subcarpetas de frontend/,
# en vez de montar todo bajo el prefijo /frontend (que no coincide
# con lo que el HTML realmente solicita).
app.mount("/css", StaticFiles(directory=os.path.join(FRONTEND_DIR, "css")), name="css")
app.mount("/js", StaticFiles(directory=os.path.join(FRONTEND_DIR, "js")), name="js")

# ── Routers ──
app.include_router(info.router)
app.include_router(pages.router)
app.include_router(mercado.router)
app.include_router(analisis.router)
app.include_router(recomendaciones.router)
app.include_router(conversacional.router)
app.include_router(chat.router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)