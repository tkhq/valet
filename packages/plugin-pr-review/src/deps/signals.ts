/**
 * Checks that need no network: names close to popular packages
 * (typosquats) and license comparison.
 */
import { normalizePypi, type Ecosystem } from "./parse.js";

/** Widely used package names per ecosystem. A new name one edit away from one of these is a typosquat candidate. */
const POPULAR: Record<Ecosystem, readonly string[]> = {
  npm: [
    "react", "react-dom", "preact", "vue", "svelte", "next", "nuxt", "express", "koa", "fastify", "lodash", "lodash-es", "underscore",
    "ramda", "axios", "node-fetch", "got", "request", "superagent", "chalk", "colors", "color", "commander", "yargs", "minimist", "debug",
    "dotenv", "uuid", "moment", "dayjs", "date-fns", "luxon", "typescript", "webpack", "rollup", "vite", "esbuild", "eslint", "prettier",
    "jest", "mocha", "chai", "sinon", "vitest", "cypress", "playwright", "puppeteer", "jquery", "bootstrap", "tailwindcss", "postcss", "sass",
    "less", "socket.io", "mongoose", "mongodb", "mysql", "mysql2", "sequelize", "prisma", "redis", "ioredis", "bcrypt", "bcryptjs",
    "jsonwebtoken", "passport", "cors", "helmet", "body-parser", "cookie-parser", "multer", "morgan", "winston", "pino", "bluebird", "async",
    "rxjs", "immer", "redux", "react-redux", "zustand", "mobx", "graphql", "classnames", "clsx", "styled-components", "semver", "glob",
    "rimraf", "mkdirp", "fs-extra", "chokidar", "nodemon", "concurrently", "cross-env", "inquirer", "ora", "execa", "shelljs", "yaml",
    "js-yaml", "xml2js", "cheerio", "marked", "highlight.js", "validator", "joi", "yup", "zod", "ajv", "qs", "path-to-regexp", "event-stream",
    "electron", "ethers", "web3", "viem", "crypto-js", "tslib", "core-js", "nanoid", "picocolors", "kleur", "open", "form-data", "formidable",
    "sharp", "three", "hono", "typebox", "@babel/core", "@types/node", "@types/react", "react-router", "react-router-dom", "@tanstack/react-query",
  ],
  PyPI: [
    "requests", "urllib3", "numpy", "pandas", "scipy", "matplotlib", "seaborn", "scikit-learn", "tensorflow", "torch", "keras", "flask",
    "django", "fastapi", "starlette", "uvicorn", "gunicorn", "pydantic", "sqlalchemy", "alembic", "psycopg2", "psycopg2-binary", "pymysql",
    "redis", "celery", "boto3", "botocore", "awscli", "s3transfer", "six", "setuptools", "wheel", "pip", "certifi", "idna",
    "charset-normalizer", "chardet", "python-dateutil", "pytz", "pyyaml", "jinja2", "markupsafe", "click", "rich", "typer", "attrs",
    "packaging", "cryptography", "pyopenssl", "paramiko", "oauthlib", "pillow", "beautifulsoup4", "lxml", "selenium", "scrapy", "pytest",
    "pytest-cov", "mock", "coverage", "tox", "black", "flake8", "pylint", "mypy", "isort", "httpx", "aiohttp", "websockets", "grpcio",
    "protobuf", "openai", "anthropic", "transformers", "tqdm", "colorama", "termcolor", "tabulate", "sphinx", "jmespath", "pyjwt", "bcrypt",
    "passlib", "python-dotenv", "toml", "tomli", "simplejson", "ujson", "orjson", "networkx", "sympy", "opencv-python", "pyspark", "dask",
    "xgboost", "lightgbm", "jupyter", "ipython", "web3", "eth-account",
  ],
  "crates.io": [
    "serde", "serde_json", "serde_derive", "tokio", "async-trait", "futures", "rand", "regex", "clap", "anyhow", "thiserror", "log",
    "env_logger", "tracing", "tracing-subscriber", "chrono", "time", "reqwest", "hyper", "axum", "actix-web", "warp", "tower", "bytes",
    "itertools", "lazy_static", "once_cell", "syn", "quote", "proc-macro2", "libc", "base64", "hex", "sha2", "ring", "rustls", "openssl",
    "uuid", "url", "toml", "rayon", "crossbeam", "parking_lot", "num", "bitflags", "cfg-if", "memchr", "smallvec", "indexmap", "hashbrown",
    "dashmap", "tempfile", "walkdir", "glob", "sqlx", "diesel", "prost", "tonic", "ethers", "alloy", "k256", "ed25519-dalek", "p256",
  ],
  Go: [
    "github.com/gin-gonic/gin", "github.com/gorilla/mux", "github.com/labstack/echo", "github.com/gofiber/fiber", "github.com/spf13/cobra",
    "github.com/spf13/viper", "github.com/stretchr/testify", "github.com/sirupsen/logrus", "go.uber.org/zap", "github.com/pkg/errors",
    "github.com/google/uuid", "github.com/golang/protobuf", "google.golang.org/grpc", "google.golang.org/protobuf", "github.com/aws/aws-sdk-go",
    "github.com/aws/aws-sdk-go-v2", "github.com/redis/go-redis", "github.com/go-redis/redis", "github.com/jackc/pgx", "github.com/lib/pq",
    "gorm.io/gorm", "github.com/go-sql-driver/mysql", "github.com/golang-jwt/jwt", "github.com/prometheus/client_golang", "k8s.io/client-go",
    "github.com/urfave/cli", "golang.org/x/crypto", "golang.org/x/net", "golang.org/x/sync", "github.com/mattn/go-sqlite3",
    "github.com/gorilla/websocket", "github.com/joho/godotenv", "github.com/ethereum/go-ethereum", "github.com/btcsuite/btcd",
  ],
};

/** Names shorter than this are not compared: one edit turns most short names into other real names. */
const MIN_LENGTH = 5;

export interface Typosquat {
  /** The popular package the name imitates. */
  of: string;
  /** `separator`: the same letters with other separators or case. `edit`: one letter added, dropped, changed or swapped. */
  how: "separator" | "edit";
}

/** The popular package a new name imitates, or undefined. A popular name itself is never a typosquat. */
export function typosquatOf(ecosystem: Ecosystem, name: string): Typosquat | undefined {
  const norm = (n: string): string => (ecosystem === "PyPI" ? normalizePypi(n) : n.toLowerCase());
  const popular = POPULAR[ecosystem];
  const own = norm(name);
  if (popular.some((p) => norm(p) === own)) return undefined;
  const bare = (n: string): string => norm(n).replace(/[-_.]/g, "");
  for (const p of popular) {
    // PyPI treats separators as equal, so only other ecosystems have separator squats.
    if (ecosystem !== "PyPI" && bare(p) === bare(name)) return { of: p, how: "separator" };
  }
  if (own.length < MIN_LENGTH) return undefined;
  for (const p of popular) {
    const target = norm(p);
    if (target.length >= MIN_LENGTH && editDistanceAtMostOne(own, target)) return { of: p, how: "edit" };
  }
  return undefined;
}

/** Whether `a` becomes `b` with at most one insertion, deletion, substitution or swap of adjacent letters. */
export function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Licenses that require sharing source when the code is distributed or served. */
const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|OSL|CPAL|MPL|EPL|CDDL|BUSL|Commons-Clause)\b/i;
/** The strongest of those: they reach code served over a network, or are not open source. */
const STRONG_COPYLEFT = /\b(AGPL|SSPL|BUSL|Commons-Clause|GPL-[23])/i;

const CLASS_ORDER = ["permissive", "copyleft", "strong-copyleft"] as const;

/** A license's class. An SPDX `OR` lets the user pick, so the most permissive choice counts. */
export function licenseClass(license: string | undefined): "strong-copyleft" | "copyleft" | "permissive" | "unknown" {
  if (!license?.trim()) return "unknown";
  const one = (l: string): (typeof CLASS_ORDER)[number] =>
    STRONG_COPYLEFT.test(l) && !/\bLGPL/i.test(l) ? "strong-copyleft" : COPYLEFT.test(l) ? "copyleft" : "permissive";
  const choices = license.replace(/[()]/g, "").split(/\s+OR\s+/i).map(one);
  return CLASS_ORDER[Math.min(...choices.map((c) => CLASS_ORDER.indexOf(c)))];
}

/** Two license strings name the same terms: compare without case, spaces or a trailing `-only`/`+`. */
export function sameLicense(a: string, b: string): boolean {
  const norm = (s: string): string => s.toUpperCase().replace(/\s+/g, "").replace(/-ONLY\b/g, "").replace(/[()]/g, "");
  return norm(a) === norm(b);
}
