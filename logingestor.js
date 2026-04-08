/**
 * logingestor — JavaScript SDK
 *
 * Works in Node.js 18+ (uses native fetch).
 * For older Node.js, pass a custom `fetch` via options.
 *
 * @example
 * import { LogIngestorClient } from './logingestor.js'
 *
 * const client = new LogIngestorClient({
 *   apiKey: process.env.LOGINGESTOR_API_KEY,
 *   projectId: process.env.LOGINGESTOR_PROJECT_ID,
 *   source: 'payment-service',
 * })
 *
 * await client.info('payment processed', { meta: { amount: 99 } })
 */

import { Writable } from 'stream'

const LEVELS = /** @type {const} */ (['DEBUG', 'INFO', 'WARN', 'ERROR'])

const CONSOLE_MAP = {
  DEBUG: console.debug,
  INFO:  console.info,
  WARN:  console.warn,
  ERROR: console.error,
}

/** Maps Winston level strings to ingestor levels. */
const WINSTON_LEVEL_MAP = {
  error:   'ERROR',
  warn:    'WARN',
  info:    'INFO',
  http:    'INFO',
  verbose: 'DEBUG',
  debug:   'DEBUG',
  silly:   'DEBUG',
}

/** Maps Pino numeric levels to ingestor levels. */
function pinoLevel(n) {
  if (n >= 50) return 'ERROR'
  if (n >= 40) return 'WARN'
  if (n >= 30) return 'INFO'
  return 'DEBUG'
}

export class LogIngestorClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseURL]     – override the default API base URL
   * @param {string} opts.apiKey        – API key
   * @param {string} opts.projectId     – UUID of the project
   * @param {string} [opts.source]      – default source tag (default: 'unknown')
   * @param {number} [opts.batchSize]   – flush when queue reaches this size (default: 1, sends every entry immediately)
   * @param {number} [opts.flushIntervalMs] – background flush interval ms (default: 5000)
   * @param {Function} [opts.fetch]     – custom fetch implementation
   * @param {Function} [opts.onError]   – called when an ingest request fails
   * @param {boolean}  [opts.console]   – mirror every log to the console as well (default: true)
   */
  constructor({
    baseURL = 'https://api.streamlogia.com',
    apiKey,
    projectId,
    source = 'unknown',
    batchSize = 1,
    flushIntervalMs = 5000,
    fetch: customFetch,
    onError = (err) => console.error('[logingestor]', err),
    console: mirrorConsole = true,
  }) {
    this._baseURL = baseURL.replace(/\/$/, '')
    this._apiKey = apiKey
    this._projectId = projectId
    this._source = source
    this._batchSize = batchSize
    this._onError = onError
    this._fetch = customFetch ?? globalThis.fetch.bind(globalThis)
    this._console = mirrorConsole

    /** @type {object[]} */
    this._queue = []
    this._timer = setInterval(() => this.flush(), flushIntervalMs)
    // Allow Node.js to exit even if the timer is still running
    if (this._timer.unref) this._timer.unref()
  }

  // ── Level helpers ──────────────────────────────────────────────────────────

  /** @param {string} message @param {LogOptions} [opts] */
  debug(message, opts) { return this._enqueue('DEBUG', message, opts) }

  /** @param {string} message @param {LogOptions} [opts] */
  info(message, opts) { return this._enqueue('INFO', message, opts) }

  /** @param {string} message @param {LogOptions} [opts] */
  warn(message, opts) { return this._enqueue('WARN', message, opts) }

  /** @param {string} message @param {LogOptions} [opts] */
  error(message, opts) { return this._enqueue('ERROR', message, opts) }

  // ── Direct send ────────────────────────────────────────────────────────────

  /**
   * Send an array of entries immediately, bypassing the internal queue.
   * @param {object[]} entries
   * @returns {Promise<{ingested: number, ids: string[]}>}
   */
  async ingest(entries) {
    const resp = await this._fetch(`${this._baseURL}/v1/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(entries),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`[logingestor] HTTP ${resp.status}: ${text}`)
    }

    return resp.json()
  }

  /**
   * Flush all queued entries to the server immediately.
   * Call this before your process exits.
   * @returns {Promise<void>}
   */
  async flush() {
    if (this._queue.length === 0) return
    const batch = this._queue.splice(0)
    try {
      await this.ingest(batch)
    } catch (err) {
      this._onError(err)
    }
  }

  /**
   * Flush pending logs and stop the background timer.
   * @returns {Promise<void>}
   */
  async close() {
    clearInterval(this._timer)
    await this.flush()
  }

  // ── Express / Node.js HTTP middleware ─────────────────────────────────────

  /**
   * Returns an Express (or connect-compatible) middleware that logs one entry
   * per request after the response is sent.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.logBody]  – include req body in meta (default: false)
   * @returns {import('express').RequestHandler}
   *
   * @example
   * app.use(client.expressMiddleware())
   */
  expressMiddleware(opts = {}) {
    const self = this
    return function logIngestorMiddleware(req, res, next) {
      const start = Date.now()
      let responseSize = 0

      // Wrap write/end to track response body size — mirrors the responseWriter
      // wrapper in the Go SDK (middleware.go).
      const origWrite = res.write.bind(res)
      const origEnd   = res.end.bind(res)

      res.write = function (chunk, ...args) {
        if (chunk) responseSize += Buffer.byteLength(chunk)
        return origWrite(chunk, ...args)
      }
      res.end = function (chunk, ...args) {
        if (chunk && typeof chunk !== 'function') responseSize += Buffer.byteLength(chunk)
        return origEnd(chunk, ...args)
      }

      // Hook into the response finish event — runs after headers are sent.
      res.on('finish', () => {
        const durationMs = Date.now() - start
        const status = res.statusCode

        const meta = {
          method: req.method,
          path: req.path ?? req.url,
          status,
          durationMs,
          responseSize,
          userAgent: req.headers['user-agent'],
          ip: req.ip ?? req.socket?.remoteAddress,
        }

        if (req.headers['x-request-id']) {
          meta.requestId = req.headers['x-request-id']
        }
        if (opts.logBody && req.body) {
          meta.body = req.body
        }

        const level = levelForStatus(status)
        const message = `${req.method} ${req.path ?? req.url} ${status} (${durationMs}ms)`
        self._enqueue(level, message, { meta })
      })

      next()
    }
  }

  // ── Winston integration ────────────────────────────────────────────────────

  /**
   * Returns a Winston transport class bound to this client.
   * Analogous to NewSlogHandler in the Go SDK.
   *
   * Pass the `Transport` base class from the `winston-transport` package so
   * the SDK stays free of hard dependencies.
   *
   * @param {Function} Transport  – base class from `winston-transport`
   * @returns {Function}          – a Transport subclass ready to instantiate
   *
   * @example
   * import Transport from 'winston-transport'
   * import winston from 'winston'
   *
   * const LogTransport = client.createWinstonTransport(Transport)
   * const logger = winston.createLogger({
   *   transports: [
   *     new winston.transports.Console(),   // stdout  ← mirrors MultiHandler
   *     new LogTransport(),                 // ingestor
   *   ],
   * })
   *
   * logger.info('order placed', { orderId: 'ord_123', amount: 49.99 })
   */
  createWinstonTransport(Transport) {
    const self = this
    return class LogIngestorTransport extends Transport {
      log(info, callback) {
        const { level, message, [Symbol.for('splat')]: _splat, ...rest } = info
        // Strip Winston's internal Symbol-keyed properties from meta
        const meta = Object.fromEntries(
          Object.entries(rest).filter(([k]) => typeof k === 'string')
        )
        self._enqueue(WINSTON_LEVEL_MAP[level] ?? 'INFO', message, { meta })
        callback()
      }
    }
  }

  // ── Pino integration ───────────────────────────────────────────────────────

  /**
   * Returns a Writable stream that consumes Pino's NDJSON output and forwards
   * each record to the ingestor.
   *
   * @returns {import('stream').Writable}
   *
   * @example
   * import pino from 'pino'
   *
   * const logger = pino({ level: 'debug' }, pino.multistream([
   *   { stream: process.stdout },           // stdout  ← mirrors MultiHandler
   *   { stream: client.pinoDestination() }, // ingestor
   * ]))
   *
   * logger.info({ orderId: 'ord_123' }, 'order placed')
   */
  pinoDestination() {
    const self = this
    let buf = ''
    return new Writable({
      write(chunk, _enc, cb) {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() // keep any incomplete trailing line
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const { level, msg, time: _t, pid: _p, hostname: _h, ...meta } = JSON.parse(line)
            self._enqueue(pinoLevel(level), msg ?? '', { meta })
          } catch { /* ignore malformed lines */ }
        }
        cb()
      },
    })
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /**
   * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} level
   * @param {string} message
   * @param {{ tags?: string[], meta?: object, source?: string }} [opts]
   */
  _enqueue(level, message, opts = {}) {
    // Mirror to console if enabled
    if (this._console) {
      const fn = CONSOLE_MAP[level] ?? console.log
      fn(`[${level}] ${message}`, opts.meta ?? {})
    }

    this._queue.push({
      projectId: this._projectId,
      level,
      message,
      source: opts.source ?? this._source,
      timestamp: new Date().toISOString(),
      tags: opts.tags ?? [],
      meta: opts.meta ?? {},
    })

    if (this._queue.length >= this._batchSize) {
      // fire-and-forget
      this.flush()
    }
  }
}

/** @param {number} status @returns {'INFO'|'WARN'|'ERROR'} */
function levelForStatus(status) {
  if (status >= 500) return 'ERROR'
  if (status >= 400) return 'WARN'
  return 'INFO'
}

/**
 * @typedef {object} LogOptions
 * @property {string[]} [tags]
 * @property {object}   [meta]
 * @property {string}   [source]  – override the default source for this entry
 */
