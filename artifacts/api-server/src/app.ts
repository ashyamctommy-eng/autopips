import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import cookieParser from "cookie-parser";
import migrationApi from "./migration-api";

const app: Express = express();

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
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '10mb', verify(req, _res, buffer) { (req as any).rawBody = buffer; } }));
app.use(express.urlencoded({ extended: true, verify(req, _res, buffer) { (req as any).rawBody = buffer; } }));
app.use(express.raw({ type: 'multipart/form-data', limit: '25mb', verify(req, _res, buffer) { (req as any).rawBody = buffer; } }));

app.use(migrationApi);

app.use("/api", router);

export default app;
