import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { WireEvent } from "../wire/types.js";
import { httpToWsUrl, streamSession } from "./stream.js";

describe("httpToWsUrl", () => {
  it("maps http → ws with the session path", () => {
    expect(httpToWsUrl("http://localhost:8788", "s1")).toBe(
      "ws://localhost:8788/api/sessions/s1/ws",
    );
  });

  it("maps https → wss", () => {
    expect(httpToWsUrl("https://valet.example.com", "abc")).toBe(
      "wss://valet.example.com/api/sessions/abc/ws",
    );
  });

  it("preserves a base path prefix", () => {
    expect(httpToWsUrl("http://host:9000/prefix", "s2")).toBe(
      "ws://host:9000/prefix/api/sessions/s2/ws",
    );
  });

  it("appends fromOffset as a query param", () => {
    expect(httpToWsUrl("http://localhost:8788", "s1", 17)).toBe(
      "ws://localhost:8788/api/sessions/s1/ws?fromOffset=17",
    );
  });

  it("url-encodes the session id", () => {
    expect(httpToWsUrl("http://localhost:8788", "org:org_1")).toBe(
      "ws://localhost:8788/api/sessions/org%3Aorg_1/ws",
    );
  });
});

describe("streamSession over a live socket", () => {
  let wss: WebSocketServer;
  let baseUrl: string;
  let capturedKey: string | string[] | undefined;
  let capturedPath: string | undefined;

  beforeEach(async () => {
    capturedKey = undefined;
    capturedPath = undefined;
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
    const addr = wss.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    wss.on("connection", (socket, req) => {
      capturedKey = req.headers["x-api-key"];
      capturedPath = req.url;
      socket.send(
        JSON.stringify({
          type: "message_start",
          seq: 1,
          ts: 1,
          offset: "1",
          threadId: "t1",
          messageId: "m1",
          role: "assistant",
        }),
      );
      // A malformed frame in the middle must be dropped, not crash the stream.
      socket.send("this is not json");
      socket.send(
        JSON.stringify({
          type: "text_delta",
          seq: 2,
          ts: 2,
          offset: "2",
          threadId: "t1",
          messageId: "m1",
          delta: "hi",
        }),
      );
      socket.send(
        JSON.stringify({
          type: "submission.settled",
          seq: 3,
          ts: 3,
          offset: "3",
          sessionId: "s1",
          threadId: "t1",
          queueItemId: "q1",
          outcome: "completed",
        }),
      );
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("yields frames in order until submission.settled and carries x-api-key", async () => {
    const events: WireEvent[] = [];
    for await (const ev of streamSession({
      url: baseUrl,
      apiKey: "vlt_stream",
      sessionId: "s1",
    })) {
      events.push(ev);
      if (ev.type === "submission.settled") break;
    }

    expect(capturedKey).toBe("vlt_stream");
    expect(capturedPath).toBe("/api/sessions/s1/ws");
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "text_delta",
      "submission.settled",
    ]);
    const settled = events[2];
    expect(settled.type).toBe("submission.settled");
    if (settled.type === "submission.settled") {
      expect(settled.outcome).toBe("completed");
      expect(settled.queueItemId).toBe("q1");
    }
  });

  it("omits x-api-key when no apiKey is given", async () => {
    for await (const ev of streamSession({ url: baseUrl, sessionId: "s1" })) {
      if (ev.type === "submission.settled") break;
    }
    expect(capturedKey).toBeUndefined();
  });
});
