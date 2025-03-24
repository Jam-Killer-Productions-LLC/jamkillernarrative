/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import type { Context } from 'hono';

/**
 * Environment interface shared by both the front-end routes and the Durable Object.
 */
interface Env {
  NARRATIVE_DO: DurableObjectNamespace;
  AI: {
    run: (
      model: string,
      options: { messages: Array<{ role: string; content: string }> }
    ) => Promise<{ choices: Array<{ message: { content: string } }> }>;
  };
  RATE_LIMIT_KV: KVNamespace;
}

/**
 * Durable Object class for managing narrative state.
 */
export class NarrativeDO {
  state: DurableObjectState;
  narrativeState: { answers: string[]; createdAt: number; lastUpdated: number };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    // Initialize with an empty state.
    this.narrativeState = { answers: [], createdAt: Date.now(), lastUpdated: Date.now() };
    // Block concurrency until state initialization is complete.
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<any>('narrativeState');
      if (stored) {
        this.narrativeState = stored;
        console.log("Loaded stored state:", this.narrativeState);
      } else {
        console.log("No stored state found. Starting fresh.");
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // =========================
      // 1) Handle OPTIONS (CORS)
      // =========================
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      if (request.method === "POST" && path.startsWith("/update")) {
        // Log the raw body for debugging. Use request.clone() so the stream isn't consumed.
        const rawBody = await request.clone().text();
        console.log("DO /update raw body:", rawBody);

        // Parse JSON payload.
        let payload;
        try {
          payload = await request.clone().json();
          console.log("DO /update parsed payload:", payload);
        } catch (e) {
          console.error("Failed to parse JSON payload:", e);
          return new Response(
            JSON.stringify({ error: "Invalid JSON payload" }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
                "Access-Control-Allow-Credentials": "true"
              },
            }
          );
        }

        const { answer } = payload as { answer: string };
        if (
          !answer ||
          typeof answer !== "string" ||
          answer.trim().length === 0 ||
          answer.length > 1000
        ) {
          return new Response(
            JSON.stringify({ error: "Invalid answer provided" }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
                "Access-Control-Allow-Credentials": "true"
              },
            }
          );
        }

        if (this.narrativeState.answers.length >= 20) {
          return new Response(
            JSON.stringify({ error: "Maximum number of answers reached" }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
                "Access-Control-Allow-Credentials": "true"
              },
            }
          );
        }

        const sanitizedAnswer = answer.trim();
        console.log("DO state before update:", this.narrativeState);
        this.narrativeState.answers.push(sanitizedAnswer);
        this.narrativeState.lastUpdated = Date.now();
        await this.state.storage.put("narrativeState", this.narrativeState);
        console.log("DO state after update:", this.narrativeState);

        return new Response(
          JSON.stringify({
            message: "Answer added successfully",
            answerCount: this.narrativeState.answers.length,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
              "Access-Control-Allow-Credentials": "true"
            },
          }
        );
      } else if (request.method === "POST" && path.startsWith("/finalize")) {
        console.log("DO /finalize request received.");

        if (this.narrativeState.answers.length < 1) {
          return new Response(
            JSON.stringify({ error: "Insufficient answers to finalize narrative" }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
                "Access-Control-Allow-Credentials": "true"
              },
            }
          );
        }

        const promptContent = this.narrativeState.answers.join("\n");
        const systemMessage = `You are a narrative storyteller for "Don't Kill The Jam, a Jam Killer Story." 
The user provided these answers:
${promptContent}
Generate a creative, detailed narrative that captures their dystopian music journey.`.replace(/<\/?[^>]+(>|$)/g, "");
        const userMessage = "Provide a final narrative text with rich imagery and emotional depth.";
        const messages = [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage },
        ];

        // Call the AI service; fallback if it fails.
        const aiResponse = await (async () => {
          try {
            return await (globalThis as any).env.AI.run("@cf/meta/llama-3-8b-instruct", {
              messages,
            });
          } catch (error) {
            console.error("AI call failed:", error);
            return { choices: [{ message: { content: `Final Narrative: ${promptContent}` } }] };
          }
        })();

        const finalNarrativeText = aiResponse.choices[0].message.content;
        const totalAnswerLength = this.narrativeState.answers.reduce((sum, ans) => sum + ans.length, 0);
        const averageAnswerLength = totalAnswerLength / this.narrativeState.answers.length;
        const answerCountFactor = Math.min(this.narrativeState.answers.length / 10, 1);
        const mojoScore = Math.min(Math.floor(averageAnswerLength * 10 + answerCountFactor * 20), 100);
        const finalNarrativeData = {
          narrativeText: finalNarrativeText,
          mojoScore,
          timestamp: Date.now(),
          metadata: {
            answerCount: this.narrativeState.answers.length,
            processingTime: 0,
          },
        };
        await this.state.storage.put("finalNarrative", finalNarrativeData);
        console.log("DO finalized narrative:", finalNarrativeData);

        return new Response(
          JSON.stringify({ message: "Narrative finalized successfully", data: finalNarrativeData }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
              "Access-Control-Allow-Credentials": "true"
            },
          }
        );
      } else {
        return new Response(
          JSON.stringify({ error: "Not found" }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
              "Access-Control-Allow-Credentials": "true"
            },
          }
        );
      }
    } catch (error) {
      console.error("DO error:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
            "Access-Control-Allow-Credentials": "true"
          },
        }
      );
    }
  }
}

/**
 * Front-end Routing Worker using Hono.
 * This code receives public HTTP requests and forwards them to the appropriate Durable Object.
 */
const app = new Hono<{ Bindings: Env }>();

// Apply common middleware: logging, pretty JSON, CORS, and security headers.
app.use("*", logger());
app.use("*", prettyJSON());
app.use(
  "*",
  cors({
    origin: ["https://mojohand.producerprotocol.pro"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: true,
    maxAge: 86400,
  })
);

// Explicit OPTIONS route for Hono-level preflight.
app.options("*", (c) =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "https://mojohand.producerprotocol.pro",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    },
  })
);

app.use("*", async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("X-XSS-Protection", "1; mode=block");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Content-Security-Policy", "default-src 'self'; script-src 'none'; style-src 'none';");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  await next();
});

// Health check route.
app.get("/", (c) => c.json({ status: "ok", message: "Narrative API (Durable Object version) is running" }));

// Route to update narrative state.
// This reads the body once and forwards it to the Durable Object.
app.post("/narrative/update/:userId", async (c) => {
  const userId = c.req.param("userId");
  if (!userId || userId.length > 100) {
    return c.json({ error: "Invalid user ID" }, 400);
  }
  const id = c.env.NARRATIVE_DO.idFromName(userId);
  const stub = c.env.NARRATIVE_DO.get(id);
  const bodyText = await c.req.text();
  console.log(`Routing /narrative/update/${userId} with body:`, bodyText);
  const response = await stub.fetch("https://dummy/update", {
    method: "POST",
    headers: c.req.raw.headers,
    body: bodyText,
  });
  return response;
});

// Route to finalize narrative.
app.post("/narrative/finalize/:userId", async (c) => {
  const userId = c.req.param("userId");
  if (!userId || userId.length > 100) {
    return c.json({ error: "Invalid user ID" }, 400);
  }
  const id = c.env.NARRATIVE_DO.idFromName(userId);
  const stub = c.env.NARRATIVE_DO.get(id);
  const bodyText = await c.req.text();
  console.log(`Routing /narrative/finalize/${userId} with body:`, bodyText);
  const response = await stub.fetch("https://dummy/finalize", {
    method: "POST",
    headers: c.req.raw.headers,
    body: bodyText,
  });
  return response;
});

const FAVICON_URL = "https://bafybeig6dpytw3q4v7vzdy6sb7q4x3apqgrvfi3zsbvb3n6wvs5unfr36i.ipfs.dweb.link?filename=480.gif";

// Handle favicon.ico requests
async function handleFaviconRequest(): Promise<Response> {
  try {
    // Fetch the GIF from IPFS
    const response = await fetch(FAVICON_URL);
    
    if (!response.ok) {
      throw new Error('Failed to fetch favicon');
    }

    // Return the GIF with appropriate headers
    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
      }
    });
  } catch (error) {
    // If fetch fails, return a 204 No Content
    return new Response(null, { status: 204 });
  }
}

export default app;