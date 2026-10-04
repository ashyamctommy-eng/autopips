import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import cookieParser from "cookie-parser";
import migrationApi from "./migration-api";
import mobileApi from "./mobile-api";

const app: Express = express();

const allowedBrowserOrigins = new Set(
  [
    'https://autopips.replit.app',
    process.env.NEXT_PUBLIC_APP_URL,
    ...(process.env.CORS_ALLOWED_ORIGINS ?? '').split(','),
    ...(process.env.NODE_ENV === 'production'
      ? []
      : [
          ...(process.env.REPLIT_DEV_DOMAIN ? [`https://${process.env.REPLIT_DEV_DOMAIN}`] : []),
          'http://localhost:20895',
          'http://localhost:5173',
          'http://localhost:3000',
          'http://127.0.0.1:3000',
        ]),
  ]
    .map((origin) => origin?.trim().replace(/\/+$/, ''))
    .filter((origin): origin is string => Boolean(origin)),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || allowedBrowserOrigins.has(origin));
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use((req, res, next) => {
  const hasSessionCookie = Boolean(req.cookies?.ap_at || req.cookies?.ap_rt);
  const isSafeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  const origin = req.get('origin');

  // SameSite=None is required by the separately hosted browser app. Keep
  // cookie-authenticated mutations protected against cross-site form requests;
  // bearer-authenticated mobile/server clients remain unaffected.
  if (hasSessionCookie && !isSafeMethod && origin && !allowedBrowserOrigins.has(origin)) {
    return res.status(403).json({
      ok: false,
      error: { code: 'CROSS_ORIGIN_REQUEST', message: 'Cross-origin session request denied.' },
    });
  }

  return next();
});
app.use(express.json({ limit: '10mb', verify(req, _res, buffer) { (req as any).rawBody = buffer; } }));
app.use(express.urlencoded({ extended: true, verify(req, _res, buffer) { (req as any).rawBody = buffer; } }));
app.use(express.raw({ type: 'multipart/form-data', limit: '25mb', verify(req, _res, buffer) { (req as any).rawBody = buffer; } }));

app.use(mobileApi);
app.use(migrationApi);

app.use("/api", router);

export default app;
