"""infrastructure/ai/gemini_brain.py — AsyncExpertBrain.

Versión mejorada del ExpertBrain async: misma lógica de prompts que el
original, pero con arquitectura en capas:

    generar()              → transporte HTTP puro, levanta excepciones tipadas
    _fetch_ticker_news()   → noticias externas (Alpha Vantage / NewsAPI)
    procesar_estrategia()  → orquesta datos + noticias + predicciones → prompt
    generar_ficha_tecnica()→ ficha de una empresa

Novedades sobre la versión anterior:
- Config centralizada (GeminiConfig) en vez de constantes sueltas.
- Excepciones tipadas en el transporte HTTP en vez de strings de error.
- Cache TTL: no vuelve a llamar a Gemini si ya generaste el mismo análisis
  hace poco (mismo df de mercado / misma empresa).
- Circuit breaker: si Gemini está caído, deja de insistir por un rato en
  vez de esperar timeouts repetidos en cada request.
- Métricas básicas (requests, fallos, cache hits) vía `stats()`.
- Soporta `async with AsyncExpertBrain(...) as brain:` para cerrar el
  cliente httpx automáticamente.
- Autenticación vía header `x-goog-api-key` (las nuevas "Auth keys" de
  Google, con prefijo AQ., requieren este método en vez de `?key=` en la URL).
- Manejo defensivo de respuestas vacías/no-JSON de Gemini: en vez de un
  500 crudo, se registra el status_code y el cuerpo real para diagnóstico.

FIX (2026-07-06): en la rama de rate limit (429) del método _generar(), antes
se llamaba a asyncio.sleep(espera) incondicionalmente, incluso en el último
intento disponible — desperdiciando 15s+ de espera del usuario sin que
hubiera ningún reintento real después. Ahora se valida `intento < max_reintentos`
antes de dormir, igual que ya hacía la rama de respuesta no-JSON.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Optional

import httpx

from infrastructure.ai.config import GeminiConfig
from infrastructure.ai.exceptions import (
    CircuitoAbiertoError,
    GeminiConnectionError,
    GeminiError,
    GeminiRateLimitError,
    GeminiTimeoutError,
)
from infrastructure.common.cache import TTLCache
from infrastructure.common.circuit_breaker import CircuitBreaker

logger = logging.getLogger(__name__)

_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class AsyncExpertBrain:
    """Asesor financiero con IA (Gemini), listo para usarse desde FastAPI."""

    def __init__(self, config: Optional[GeminiConfig] = None) -> None:
        self._config = config or GeminiConfig.from_env()
        self._client = httpx.AsyncClient(timeout=self._config.timeout_segundos)
        self._cache: TTLCache[str] = TTLCache(
            ttl_seconds=self._config.cache_ttl_segundos,
            max_size=self._config.cache_max_size,
        )
        self._circuit = CircuitBreaker(
            umbral_fallos=self._config.circuito_umbral_fallos,
            tiempo_reset=self._config.circuito_tiempo_reset,
        )
        self._stats = {"requests": 0, "fallos": 0, "cache_hits": 0}

    # ── Context manager ──

    async def __aenter__(self) -> "AsyncExpertBrain":
        return self

    async def __aexit__(self, *exc_info) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    # ── Observabilidad ──

    def stats(self) -> dict:
        return {
            **self._stats,
            "cache": self._cache.stats(),
            "circuito": self._circuit.stats(),
        }

    # ── Prompt libre (usado por el chat conversacional) ──

    async def generar_respuesta_libre(self, prompt: str) -> str:
        """Genera respuesta a un prompt libre. A diferencia de _generar(),
        atrapa las excepciones tipadas y devuelve un string amigable —
        mismo contrato que tenía ExpertBrain._generar() en la versión síncrona."""
        try:
            return await self._generar(prompt)
        except CircuitoAbiertoError as exc:
            return f"⚠️ {exc}"
        except GeminiRateLimitError:
            return "Gemini está con mucha demanda ahora mismo. Intenta de nuevo en unos segundos."
        except GeminiTimeoutError:
            return "Gemini no respondió a tiempo. Intenta de nuevo."
        except GeminiConnectionError:
            return "Sin conexión a internet. Verifica tu red."
        except GeminiError as exc:
            return f"Error de Gemini: {exc}"

    # ── Transporte HTTP puro ──

    async def _generar(self, prompt: str) -> str:
        """Llama a Gemini con reintentos. Levanta excepciones tipadas — no
        strings — para que quien orquesta (procesar_estrategia, etc.)
        decida cómo comunicar el error al usuario final."""

        if not self._circuit.permite_llamada():
            raise CircuitoAbiertoError(
                "Gemini viene fallando seguido; se pausaron los intentos un momento."
            )

        url = f"{_BASE_URL}/{self._config.modelo}:generateContent"
        headers = {"x-goog-api-key": self._config.api_key}
        payload = {"contents": [{"parts": [{"text": prompt}]}]}
        self._stats["requests"] += 1

        ultimo_error: GeminiError = GeminiError("Gemini no respondió tras los reintentos.")

        for intento in range(1, self._config.max_reintentos + 1):
            try:
                resp = await self._client.post(url, json=payload, headers=headers)

                try:
                    data = resp.json()
                except ValueError:
                    # Cuerpo vacío o no-JSON. Suele indicar un rechazo a
                    # nivel de red/proxy antes de llegar a la API real de
                    # Gemini, o una key inválida/mal copiada.
                    logger.error(
                        "Respuesta no-JSON de Gemini (status %d): %r",
                        resp.status_code, resp.text[:300],
                    )
                    ultimo_error = GeminiError(
                        f"Gemini devolvió una respuesta vacía o inválida "
                        f"(HTTP {resp.status_code}). Revisa GEMINI_API_KEY y GEMINI_MODEL."
                    )
                    if intento < self._config.max_reintentos:
                        await asyncio.sleep(3)
                        continue
                    self._circuit.registrar_fallo()
                    self._stats["fallos"] += 1
                    raise ultimo_error

                if "candidates" in data:
                    self._circuit.registrar_exito()
                    return data["candidates"][0]["content"]["parts"][0]["text"]

                error = data.get("error", {})
                codigo = error.get("code", 0)
                mensaje = error.get("message", str(data))

                if codigo == 429 or any(
                    x in mensaje.lower() for x in ("high demand", "overloaded", "try again")
                ):
                    ultimo_error = GeminiRateLimitError(mensaje)
                    # FIX: antes se dormía siempre, incluso en el último intento
                    # disponible, desperdiciando 15s+ sin que hubiera reintento
                    # real después. Ahora solo se duerme si de verdad va a
                    # haber otro intento.
                    if intento < self._config.max_reintentos:
                        espera = 15 * intento
                        logger.warning(
                            "Gemini rate limit (intento %d/%d). Esperando %ds.",
                            intento, self._config.max_reintentos, espera,
                        )
                        await asyncio.sleep(espera)
                        continue
                    logger.warning(
                        "Gemini rate limit (intento %d/%d). Sin más reintentos disponibles.",
                        intento, self._config.max_reintentos,
                    )
                    break

                if codigo == 503:
                    ultimo_error = GeminiError(f"Gemini no disponible (503): {mensaje}")
                    if intento < self._config.max_reintentos:
                        await asyncio.sleep(20)
                        continue
                    break

                # Error no recuperable — no tiene sentido reintentar
                logger.error("Error no recuperable de Gemini (código %s): %s", codigo, mensaje)
                self._circuit.registrar_fallo()
                raise GeminiError(f"Error de Gemini: {mensaje}")

            except httpx.TimeoutException:
                ultimo_error = GeminiTimeoutError("Gemini no respondió a tiempo.")
                logger.warning("Timeout intento %d/%d", intento, self._config.max_reintentos)
                if intento < self._config.max_reintentos:
                    await asyncio.sleep(5)
                    continue

            except httpx.ConnectError as exc:
                self._circuit.registrar_fallo()
                raise GeminiConnectionError("Sin conexión a internet.") from exc

        self._circuit.registrar_fallo()
        self._stats["fallos"] += 1
        raise ultimo_error

    # ── Noticias externas ──

    async def _fetch_ticker_news(self, ticker: str) -> str:
        if self._config.av_key:
            try:
                r = await self._client.get(
                    "https://www.alphavantage.co/query",
                    params={
                        "function": "NEWS_SENTIMENT",
                        "tickers": ticker,
                        "apikey": self._config.av_key,
                        "limit": "2",
                    },
                    timeout=5.0,
                )
                data = r.json()
                if data.get("feed"):
                    partes = [
                        f"[{ticker}] {n['title']} "
                        f"(Sentimiento: {n.get('overall_sentiment_label', 'Neutral')}, "
                        f"Fecha: {n.get('time_published', '')[:8]})"
                        for n in data["feed"][:2]
                        if n.get("title")
                    ]
                    if partes:
                        return "\n".join(partes)
            except Exception:
                pass

        if self._config.news_key:
            try:
                r = await self._client.get(
                    "https://newsapi.org/v2/everything",
                    params={
                        "q": ticker,
                        "language": "es",
                        "sortBy": "publishedAt",
                        "pageSize": "2",
                        "apiKey": self._config.news_key,
                    },
                    timeout=5.0,
                )
                data = r.json()
                if data.get("articles"):
                    partes = [
                        f"[{ticker}] {a['title']} (Fecha: {a.get('publishedAt', '')[:10]})"
                        for a in data["articles"][:2]
                        if a.get("title") and "[Removed]" not in a["title"]
                    ]
                    if partes:
                        return "\n".join(partes)
            except Exception:
                pass

        return ""

    async def _buscar_noticias_externas(self, tickers: list[str]) -> str:
        tasks = [self._fetch_ticker_news(t) for t in tickers[:4]]
        resultados = await asyncio.gather(*tasks, return_exceptions=True)
        encontradas = [r for r in resultados if isinstance(r, str) and r]
        return "\n".join(encontradas) if encontradas else ""

    # ── Casos de uso públicos ──

    async def procesar_estrategia(self, datos_mercado) -> str:
        """Análisis conversacional del portafolio completo. Cachea por
        `cache_ttl_segundos` para no regenerar lo mismo dos veces seguidas."""
        cache_key = self._hash_dataframe(datos_mercado)
        if (cacheado := await self._cache.get(cache_key)) is not None:
            self._stats["cache_hits"] += 1
            return cacheado

        filas, tickers = [], []
        for _, row in datos_mercado.iterrows():
            tendencia = "subiendo" if row["Crecimiento_%"] >= 0 else "bajando"
            filas.append(
                f"• {row['Empresa']} ({row['Ticker']}): "
                f"S/. {row['Precio']} — {tendencia} {abs(row['Crecimiento_%'])}% hoy"
            )
            tickers.append(row["Ticker"])
        resumen_mercado = "\n".join(filas)

        loop = asyncio.get_running_loop()
        noticias_ext, noticias_loc, predicciones = await asyncio.gather(
            self._buscar_noticias_externas(tickers),
            loop.run_in_executor(None, self._noticias_locales_sync, tickers),
            loop.run_in_executor(None, self._predicciones_sync, tickers, datos_mercado),
        )

        noticias = ""
        if noticias_ext:
            noticias += "NOTICIAS EN TIEMPO REAL:\n" + noticias_ext + "\n\n"
        if noticias_loc:
            noticias += "ANÁLISIS DETALLADO:\n" + noticias_loc
        if not noticias:
            noticias = "No se encontraron noticias recientes."
        if not predicciones:
            predicciones = "Predicciones no disponibles."

        prompt = f"""
Eres Pfinance, un asesor financiero peruano con 15 años de experiencia en la BVL.
Eres directo, cercano y honesto. Hablas como si le explicaras las cosas a un amigo
de confianza que quiere invertir pero no domina las finanzas.
Nunca usas jerga innecesaria. Si algo es incierto, lo dices sin rodeos.

Tienes esta información del portafolio de hoy:

═══ PRECIOS DE HOY ═══
{resumen_mercado}

═══ NOTICIAS RECIENTES ═══
{noticias}

═══ PREDICCIONES ═══
{predicciones}

Escribe el análisis de forma natural y conversacional, siguiendo esta estructura:

1. ¿QUÉ ESTÁ PASANDO HOY?
2. ¿QUÉ DICEN LAS NOTICIAS?
3. ¿QUÉ HARÍAS TÚ?
4. ¿QUÉ PODRÍA PASAR?
5. MI CONSEJO FINAL

Reglas: Español natural, sin tecnicismos. Máximo 600 palabras.
""".strip()

        try:
            resultado = await self._generar(prompt)
        except GeminiError as exc:
            return f"⚠️ {exc}"

        await self._cache.set(cache_key, resultado)
        return resultado

    async def generar_ficha_tecnica(self, empresa: str, ticker: str) -> str:
        cache_key = f"ficha:{ticker}"
        if (cacheado := await self._cache.get(cache_key)) is not None:
            self._stats["cache_hits"] += 1
            return cacheado

        loop = asyncio.get_running_loop()
        noticias_loc, noticias_ext = await asyncio.gather(
            loop.run_in_executor(None, self._noticias_locales_sync, [ticker]),
            self._buscar_noticias_externas([ticker]),
        )
        noticias = "\n".join(filter(None, [noticias_ext, noticias_loc])) or "Sin noticias recientes disponibles."

        prompt = f"""
Eres un analista financiero que conoce muy bien el mercado peruano.
Escribe una ficha sobre {empresa} ({ticker}) como si se la explicaras
a alguien que quiere invertir por primera vez. Tono cercano y directo.

Incluye:
- Qué hace esta empresa y por qué importa en el Perú
- En qué sector opera y cómo le va a ese sector actualmente
- Sus principales competidores o empresas relacionadas
- Qué dicen las noticias recientes: {noticias}
- Si fueras a invertir en ella, ¿qué te daría confianza y qué te preocuparía?

Máximo 200 palabras. Tono humano, no de informe corporativo.
""".strip()

        try:
            resultado = await self._generar(prompt)
        except GeminiError as exc:
            return f"⚠️ {exc}"

        await self._cache.set(cache_key, resultado)
        return resultado

    # ── Helpers síncronos (van a threadpool) ──

    @staticmethod
    def _hash_dataframe(df) -> str:
        """Clave de cache determinística a partir del contenido del df,
        para que dos requests con los mismos precios reusen el análisis."""
        firma = df[["Ticker", "Precio", "Crecimiento_%"]].to_csv(index=False)
        return "estrategia:" + hashlib.sha256(firma.encode()).hexdigest()[:16]

    @staticmethod
    def _noticias_locales_sync(tickers: list[str]) -> str:
        try:
            from agents.news_analyzer import NewsAnalyzer
            analyzer = NewsAnalyzer()
            bloques = []
            for ticker in tickers:
                resumen = analyzer.generar_resumen_noticias(ticker)
                tendencia = analyzer.analizar_tendencia(ticker)
                catalistas = analyzer.detectar_catalistas(ticker)
                pos = [c["titulo"] for c in catalistas.get("catalistas_positivos", [])]
                neg = [c["titulo"] for c in catalistas.get("catalistas_negativos", [])]
                bloque = f"[{ticker}] Tendencia: {tendencia['tendencia']}\n{resumen}"
                if pos:
                    bloque += f"  A favor: {', '.join(pos[:2])}\n"
                if neg:
                    bloque += f"  Riesgo: {', '.join(neg[:2])}\n"
                bloques.append(bloque)
            return "\n".join(bloques)
        except Exception as exc:
            logger.warning("NewsAnalyzer no disponible: %s", exc)
            return ""

    @staticmethod
    def _predicciones_sync(tickers: list[str], df) -> str:
        try:
            from agents.prediction_engine import PredictionEngine
            from agents.news_analyzer import NewsAnalyzer
            engine = PredictionEngine()
            analyzer = NewsAnalyzer()
            bloques = []
            for _, row in df.iterrows():
                ticker = row["Ticker"]
                precio = row["Precio"]
                crecimiento = row["Crecimiento_%"]
                score = 50 + min(max(crecimiento * 5, -40), 40)
                catalistas = analyzer.detectar_catalistas(ticker)
                corto = engine.predecir_corto_plazo(ticker, score, catalistas)
                mediano = engine.predecir_mediano_plazo(ticker, score, 50)
                largo = engine.predecir_largo_plazo(ticker, score, 70)
                escenarios = engine.generar_escenarios(ticker, precio, score)
                bloques.append(
                    f"[{ticker}]\n"
                    f"  Corto  ({corto['periodo']}): {corto['direccion']} — {corto['confianza']}\n"
                    f"  Mediano({mediano['periodo']}): {mediano['direccion']}\n"
                    f"  Largo  ({largo['periodo']}): {largo['potencial']} — {largo['outlook']}\n"
                    f"  Bajista(20%): S/. {escenarios['escenario_bajista']['precio_esperado']}\n"
                    f"  Base   (60%): S/. {escenarios['escenario_base']['precio_esperado']}\n"
                    f"  Alcista(20%): S/. {escenarios['escenario_alcista']['precio_esperado']}\n"
                )
            return "\n".join(bloques)
        except Exception as exc:
            logger.warning("PredictionEngine no disponible: %s", exc)
            return ""