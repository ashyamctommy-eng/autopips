---
name: Render WebSocket hosting
description: Separate public Render worker origin needed by an externally hosted frontend.
---

The public Render API origin responds to `/healthz` but returns 404 for `/ws/socket.io`; the trading Socket.IO server is exposed through a separate worker service.

**Why:** A Vercel frontend cannot use the API origin for live trading sockets when Render does not route that socket path through the API service.

**How to apply:** Set `VITE_WS_URL` to the worker service's public HTTPS origin, not the API origin. Add exact frontend origins to `CORS_ALLOWED_ORIGINS` for both API and worker. Keep `NEXT_PUBLIC_APP_URL` aligned with the canonical site because payment callbacks use it.
