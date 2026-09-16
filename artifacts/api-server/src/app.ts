import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.disable("x-powered-by");

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

// This service has no browser session or cross-origin API contract.  In
// particular, do not enable wildcard CORS: it would let any website inspect
// the operational/configuration status routes from a visitor's browser.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  next();
});

// Keep parsers bounded even though the current API is read-only.  A future
// route must opt into a larger limit explicitly rather than turning every
// unauthenticated request into an unbounded allocation.
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "8kb" }));

app.use("/api", router);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    // Never return Express' default development error page.  Error messages
    // can contain provider details, URLs, or other server-side information.
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      Number.isInteger(error.statusCode) &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : 500;
    logger.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        statusCode,
      },
      "Unhandled HTTP request error",
    );
    res.status(statusCode).json({
      error:
        statusCode === 413
          ? "Request body too large"
          : statusCode < 500
            ? "Invalid request"
            : "Internal server error",
    });
  },
);

export default app;
